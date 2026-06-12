// Downloads the engine binaries — yt-dlp and ffmpeg — into bin/ (gitignored),
// so StreamGrab is self-contained. yt-dlp does the extraction (incl. YouTube),
// ffmpeg merges video+audio. Both are open source.
//
// Run: npm run fetch-tools
// Windows is fully automated. macOS/Linux: install yt-dlp + ffmpeg via your
// package manager (brew install yt-dlp ffmpeg / apt install ...) — the host
// finds them on PATH.

import { mkdirSync, writeFileSync, existsSync, copyFileSync, rmSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin');
const isWin = process.platform === 'win32';

async function download(url, dest) {
  process.stdout.write(`  ${url}\n`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  console.log(`  -> ${dest.replace(ROOT, '.')}  (${(buf.length / 1048576).toFixed(1)} MiB)`);
}

async function main() {
  mkdirSync(BIN, { recursive: true });

  if (!isWin) {
    console.log('Non-Windows platform detected.');
    console.log('Install the tools with your package manager, e.g.:');
    console.log('  macOS:  brew install yt-dlp ffmpeg');
    console.log('  Linux:  sudo apt install yt-dlp ffmpeg   (or pipx install yt-dlp)');
    console.log('The native host will pick them up from PATH.');
    return;
  }

  console.log('Downloading yt-dlp...');
  await download(
    'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
    join(BIN, 'yt-dlp.exe'),
  );

  console.log('Downloading ffmpeg (this one is large)...');
  try {
    const zip = join(BIN, '_ffmpeg.zip');
    await download(
      'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip',
      zip,
    );
    const tmp = join(BIN, '_ffmpeg_extract');
    rmSync(tmp, { recursive: true, force: true });
    // Use PowerShell's Expand-Archive — no third-party unzip dependency.
    execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${tmp}' -Force`]);
    // Find ffmpeg.exe / ffprobe.exe inside the extracted folder.
    const top = readdirSync(tmp).map((d) => join(tmp, d, 'bin'));
    const binDir = top.find((p) => existsSync(join(p, 'ffmpeg.exe')));
    if (!binDir) throw new Error('ffmpeg.exe not found in archive');
    copyFileSync(join(binDir, 'ffmpeg.exe'), join(BIN, 'ffmpeg.exe'));
    if (existsSync(join(binDir, 'ffprobe.exe'))) copyFileSync(join(binDir, 'ffprobe.exe'), join(BIN, 'ffprobe.exe'));
    rmSync(tmp, { recursive: true, force: true });
    rmSync(zip, { force: true });
    console.log('  -> ./bin/ffmpeg.exe');
  } catch (e) {
    console.warn(`\n  ffmpeg auto-install failed: ${e.message}`);
    console.warn('  Install it manually (winget install ffmpeg) or drop ffmpeg.exe into bin/.');
    console.warn('  Without ffmpeg, only already-merged formats can be downloaded.');
  }

  console.log('\nDone. Tools are in bin/.');
}

main().catch((e) => {
  console.error('\nfetch-tools failed:', e.message);
  process.exit(1);
});
