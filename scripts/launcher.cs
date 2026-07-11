// VideoGrabitel native-messaging launcher (Windows).
//
// Compiled with `csc /target:winexe` so it has NO console subsystem — Chrome can
// launch it as the native host without a black console window flashing on every
// download (a .bat launcher cannot avoid that flash).
//
// It is a pure pass-through: it takes the stdin/stdout/stderr handles Chrome gave
// it and hands those exact handles to `node host.js` via CreateProcess. The
// native-messaging protocol bytes flow straight between Chrome and node; this
// process only waits for node to exit and relays its exit code.
//
// We P/Invoke CreateProcess (rather than System.Diagnostics.Process) because .NET
// only lets a child inherit standard handles when a stream is redirected — and we
// must NOT redirect (that would interpose this process in the byte stream). With
// STARTF_USESTDHANDLES + inheritable handles, the child inherits Chrome's pipes
// directly and we stay out of the data path.
//
// Built at install time by scripts/install-host.mjs using the in-box C# compiler
// (Microsoft.NET\Framework64\v4.0.30319\csc.exe) — no external toolchain, no
// checked-in binary. install-host falls back to the .bat if csc is unavailable.

using System;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;

class Launcher
{
    const int STARTF_USESTDHANDLES = 0x00000100;
    const uint CREATE_NO_WINDOW = 0x08000000;
    const uint INFINITE = 0xFFFFFFFF;
    const int STD_INPUT_HANDLE = -10;
    const int STD_OUTPUT_HANDLE = -11;
    const int STD_ERROR_HANDLE = -12;
    const uint HANDLE_FLAG_INHERIT = 0x00000001;

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public uint dwProcessId; public uint dwThreadId; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput, hStdOutput, hStdError;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetHandleInformation(IntPtr hObject, uint dwMask, uint dwFlags);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcess(
        string lpApplicationName, StringBuilder lpCommandLine, IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment,
        string lpCurrentDirectory, ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr hObject);

    static void MakeInheritable(IntPtr h)
    {
        if (h != IntPtr.Zero && h != new IntPtr(-1))
            SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
    }

    static int Main(string[] args)
    {
        try
        {
            string exeDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            string hostJs = Path.Combine(exeDir, "src", "native-host", "host.js");
            string node = FindNode(); // full path, or null if we couldn't resolve one

            var cmd = new StringBuilder();
            cmd.Append(Quote(node ?? "node.exe"));
            cmd.Append(' ').Append(Quote(hostJs));
            foreach (var a in args) { cmd.Append(' '); cmd.Append(Quote(a)); }

            var si = new STARTUPINFO();
            si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            si.dwFlags = STARTF_USESTDHANDLES;
            si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
            si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
            si.hStdError = GetStdHandle(STD_ERROR_HANDLE);

            // The child only inherits these if they are flagged inheritable.
            MakeInheritable(si.hStdInput);
            MakeInheritable(si.hStdOutput);
            MakeInheritable(si.hStdError);

            // When node is null we pass lpApplicationName=null so CreateProcess
            // parses the command line and searches PATH for node.exe — it does NOT
            // search PATH when lpApplicationName is non-null. This lets shim-based
            // installs (Volta, Scoop, fnm, nvm-windows) work like the .bat does.
            PROCESS_INFORMATION pi;
            bool ok = CreateProcess(node, cmd, IntPtr.Zero, IntPtr.Zero,
                true, CREATE_NO_WINDOW, IntPtr.Zero, exeDir, ref si, out pi);
            if (!ok) return 2;

            WaitForSingleObject(pi.hProcess, INFINITE);
            uint code;
            GetExitCodeProcess(pi.hProcess, out code);
            CloseHandle(pi.hThread);
            CloseHandle(pi.hProcess);
            return (int)code;
        }
        catch
        {
            return 1;
        }
    }

    // Resolve node.exe explicitly so we never depend on CreateProcess's PATH quirks.
    static string FindNode()
    {
        string pf = Environment.GetEnvironmentVariable("ProgramFiles");
        if (!string.IsNullOrEmpty(pf))
        {
            string c = Path.Combine(pf, "nodejs", "node.exe");
            if (File.Exists(c)) return c;
        }
        string pf86 = Environment.GetEnvironmentVariable("ProgramFiles(x86)");
        if (!string.IsNullOrEmpty(pf86))
        {
            string c = Path.Combine(pf86, "nodejs", "node.exe");
            if (File.Exists(c)) return c;
        }
        string path = Environment.GetEnvironmentVariable("PATH");
        if (!string.IsNullOrEmpty(path))
        {
            foreach (var dir in path.Split(';'))
            {
                if (string.IsNullOrWhiteSpace(dir)) continue;
                try
                {
                    string c = Path.Combine(dir.Trim(), "node.exe");
                    if (File.Exists(c)) return c;
                }
                catch { /* malformed PATH entry */ }
            }
        }
        return null; // unresolved — caller lets CreateProcess search PATH
    }

    // CommandLineToArgvW-compatible quoting for a single argument.
    static string Quote(string s)
    {
        if (string.IsNullOrEmpty(s)) return "\"\"";
        if (s.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return s;
        var sb = new StringBuilder();
        sb.Append('"');
        int backslashes = 0;
        foreach (char c in s)
        {
            if (c == '\\') { backslashes++; continue; }
            if (c == '"') { sb.Append('\\', backslashes * 2 + 1); sb.Append('"'); backslashes = 0; continue; }
            if (backslashes > 0) { sb.Append('\\', backslashes); backslashes = 0; }
            sb.Append(c);
        }
        if (backslashes > 0) sb.Append('\\', backslashes * 2);
        sb.Append('"');
        return sb.ToString();
    }
}
