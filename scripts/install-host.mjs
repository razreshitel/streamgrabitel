// Registers (or unregisters) the VideoGrabitel native messaging host with
// Chrome/Edge/Chromium on Windows, macOS and Linux — one cross-platform script.
//
//   npm run install-host
//   npm run uninstall-host   (runs this with --uninstall)
//
// Windows: writes a manifest next to the repo and points HKCU registry keys at it.
// macOS/Linux: drops the manifest into each browser's NativeMessagingHosts dir
// (its presence there IS the registration) and marks the .sh launcher executable.

import { mkdirSync, writeFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import os from 'node:os';

const HOST_NAME = 'com.videograbitel.host';
// Pinned extension id, derived from manifest.json "key" (see scripts/gen-key.mjs).
const EXTENSION_ID = 'eogbccakibimjjinpjpbenjnmfgobegc';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const uninstall = process.argv.includes('--uninstall');
const home = os.homedir();

const BAT = join(ROOT, 'videograbitel-host.bat');
const SH = join(ROOT, 'videograbitel-host.sh');
const EXE = join(ROOT, 'videograbitel-host.exe');

// Manifest path is chosen per-OS at install time (see install*). On Windows we
// prefer a compiled no-console launcher; elsewhere it's the .sh.
function manifestJson(launcherPath) {
  return JSON.stringify(
    {
      name: HOST_NAME,
      description: 'VideoGrabitel download helper (yt-dlp + ffmpeg)',
      path: launcherPath,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
    },
    null,
    2,
  );
}

// Build the GUI-subsystem launcher (scripts/launcher.cs) with the in-box C#
// compiler so Chrome launches the host with NO console window flashing. Returns
// the exe path, or null to fall back to the .bat (which can flash a console).
function buildWindowsLauncher() {
  const src = join(ROOT, 'scripts', 'launcher.cs');
  if (!existsSync(src)) return null;
  const win = process.env.WINDIR || 'C:\\Windows';
  const csc = [
    join(win, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    join(win, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ].find((c) => existsSync(c));
  if (!csc) return null;
  try {
    execFileSync(csc, ['/nologo', '/target:winexe', '/optimize+', `/out:${EXE}`, src], { stdio: 'ignore' });
    return existsSync(EXE) ? EXE : null;
  } catch {
    return null;
  }
}

// Per-OS directories where Chromium-family browsers look for host manifests.
function manifestDirs() {
  if (process.platform === 'darwin') {
    const base = join(home, 'Library', 'Application Support');
    return [
      join(base, 'Google', 'Chrome', 'NativeMessagingHosts'),
      join(base, 'Microsoft Edge', 'NativeMessagingHosts'),
      join(base, 'Chromium', 'NativeMessagingHosts'),
    ];
  }
  // linux
  return [
    join(home, '.config', 'google-chrome', 'NativeMessagingHosts'),
    join(home, '.config', 'microsoft-edge', 'NativeMessagingHosts'),
    join(home, '.config', 'chromium', 'NativeMessagingHosts'),
  ];
}

const WIN_REG_KEYS = [
  `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
  `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`,
];

function installWindows() {
  const exe = buildWindowsLauncher();
  const launcherPath = exe || BAT;
  const manifestPath = join(ROOT, `${HOST_NAME}.json`);
  writeFileSync(manifestPath, manifestJson(launcherPath));
  for (const key of WIN_REG_KEYS) {
    execFileSync('reg', ['add', key, '/ve', '/d', manifestPath, '/f'], { stdio: 'ignore' });
    console.log(`registered ${key}`);
  }
  console.log(
    exe
      ? 'launcher: compiled videograbitel-host.exe (no console window)'
      : 'launcher: videograbitel-host.bat (a console window may briefly flash — csc.exe not found)',
  );
}

function uninstallWindows() {
  for (const key of WIN_REG_KEYS) {
    try {
      execFileSync('reg', ['delete', key, '/f'], { stdio: 'ignore' });
      console.log(`removed ${key}`);
    } catch {
      /* not present */
    }
  }
  // Registry keys are gone above, so the host is already unregistered; don't let a
  // locked file abort the rest. The .exe is locked while a download is in flight.
  try {
    rmSync(join(ROOT, `${HOST_NAME}.json`), { force: true });
  } catch {
    /* leave it */
  }
  try {
    rmSync(EXE, { force: true });
  } catch {
    console.log('note: videograbitel-host.exe is in use — close Chrome, then delete it manually.');
  }
}

function installPosix() {
  if (existsSync(SH)) chmodSync(SH, 0o755);
  const json = manifestJson(SH);
  for (const dir of manifestDirs()) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${HOST_NAME}.json`), json);
    console.log(`installed ${join(dir, `${HOST_NAME}.json`)}`);
  }
}

function uninstallPosix() {
  for (const dir of manifestDirs()) {
    rmSync(join(dir, `${HOST_NAME}.json`), { force: true });
  }
  console.log('removed host manifests');
}

const launcher = process.platform === 'win32' ? BAT : SH;
if (!existsSync(launcher) && !uninstall) {
  console.error(`Launcher not found: ${launcher}`);
  process.exit(1);
}

if (process.platform === 'win32') {
  uninstall ? uninstallWindows() : installWindows();
} else {
  uninstall ? uninstallPosix() : installPosix();
}

console.log(uninstall ? 'Native host unregistered.' : `Native host installed for extension id ${EXTENSION_ID}.`);
if (!uninstall) console.log('Reload the extension at chrome://extensions if it was already loaded.');
