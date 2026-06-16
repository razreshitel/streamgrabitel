// Downloads the engine binaries into bin/ (gitignored) so StreamGrabitel is
// self-contained: yt-dlp (extraction, incl. YouTube), ffmpeg (merge video+audio),
// and Deno (the JS runtime yt-dlp uses to solve YouTube's challenges reliably).
// All open source. Idempotent — re-running only fetches what's missing.
//
// Run: npm run fetch-tools
// macOS/Linux: install yt-dlp, ffmpeg and deno via your package manager; the
// native host finds them on PATH.

import { mkdirSync, writeFileSync, existsSync, copyFileSync, rmSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  // Write to a temp file then rename — an interrupted run never leaves a
  // half-written binary that the "already present" check would later trust.
  const tmp = `${dest}.part`;
  writeFileSync(tmp, buf);
  renameSync(tmp, dest);
  console.log(`  -> ${dest.replace(ROOT, '.')}  (${(buf.length / 1048576).toFixed(1)} MiB)`);
}

// Verify yt-dlp.exe against the official SHA2-256SUMS from the same release.
// Guards against a corrupted/MITM'd download (delete + abort on mismatch).
async function verifyYtDlp(file) {
  try {
    const res = await fetch('https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS');
    if (!res.ok) return console.warn('  (could not fetch checksums — skipping yt-dlp verification)');
    const line = (await res.text()).split('\n').map((l) => l.trim()).find((l) => /\byt-dlp\.exe$/.test(l));
    if (!line) return console.warn('  (no yt-dlp.exe checksum entry — skipping verification)');
    const expected = line.split(/\s+/)[0].toLowerCase();
    const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
    if (actual !== expected) {
      rmSync(file, { force: true });
      throw new Error(`yt-dlp.exe checksum mismatch — download rejected (expected ${expected}, got ${actual})`);
    }
    console.log('  yt-dlp checksum verified.');
  } catch (e) {
    if (/mismatch/.test(e.message)) throw e;
    console.warn('  yt-dlp verification skipped:', e.message);
  }
}

function unzip(zip, dest) {
  rmSync(dest, { recursive: true, force: true });
  execFileSync('powershell', [
    '-NoProfile',
    '-Command',
    `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dest}' -Force`,
  ]);
}

async function main() {
  mkdirSync(BIN, { recursive: true });

  if (!isWin) {
    console.log('Non-Windows platform detected. Install the tools with your package manager:');
    console.log('  macOS:  brew install yt-dlp ffmpeg deno');
    console.log('  Linux:  sudo apt install ffmpeg ; pipx install yt-dlp ; (deno: https://deno.land)');
    console.log('The native host finds them on PATH.');
    return;
  }

  // yt-dlp — single exe.
  if (existsSync(join(BIN, 'yt-dlp.exe'))) {
    console.log('yt-dlp: already present, skipping.');
  } else {
    console.log('Downloading yt-dlp...');
    await download('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe', join(BIN, 'yt-dlp.exe'));
    await verifyYtDlp(join(BIN, 'yt-dlp.exe'));
  }

  // ffmpeg — zip containing ffmpeg.exe + ffprobe.exe.
  if (existsSync(join(BIN, 'ffmpeg.exe'))) {
    console.log('ffmpeg: already present, skipping.');
  } else {
    console.log('Downloading ffmpeg (large)...');
    try {
      const zip = join(BIN, '_ffmpeg.zip');
      await download(
        'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip',
        zip,
      );
      const tmp = join(BIN, '_ffmpeg_extract');
      unzip(zip, tmp);
      const binDir = readdirSync(tmp)
        .map((d) => join(tmp, d, 'bin'))
        .find((p) => existsSync(join(p, 'ffmpeg.exe')));
      if (!binDir) throw new Error('ffmpeg.exe not found in archive');
      copyFileSync(join(binDir, 'ffmpeg.exe'), join(BIN, 'ffmpeg.exe'));
      if (existsSync(join(binDir, 'ffprobe.exe'))) copyFileSync(join(binDir, 'ffprobe.exe'), join(BIN, 'ffprobe.exe'));
      rmSync(tmp, { recursive: true, force: true });
      rmSync(zip, { force: true });
      console.log('  -> ./bin/ffmpeg.exe');
    } catch (e) {
      console.warn(`  ffmpeg auto-install failed: ${e.message}`);
      console.warn('  Install manually (winget install ffmpeg) or drop ffmpeg.exe into bin/.');
    }
  }

  // Deno — JS runtime so yt-dlp can solve YouTube's signature challenges.
  if (existsSync(join(BIN, 'deno.exe'))) {
    console.log('deno: already present, skipping.');
  } else {
    console.log('Downloading Deno (JS runtime for YouTube)...');
    try {
      const zip = join(BIN, '_deno.zip');
      await download('https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip', zip);
      const tmp = join(BIN, '_deno_extract');
      unzip(zip, tmp);
      const exe = join(tmp, 'deno.exe');
      if (!existsSync(exe)) throw new Error('deno.exe not found in archive');
      copyFileSync(exe, join(BIN, 'deno.exe'));
      rmSync(tmp, { recursive: true, force: true });
      rmSync(zip, { force: true });
      console.log('  -> ./bin/deno.exe');
    } catch (e) {
      console.warn(`  Deno auto-install failed: ${e.message}`);
      console.warn('  YouTube may be less reliable without it — get it from https://deno.land');
    }
  }

  console.log('\nDone. Tools are in bin/.');
}

main().catch((e) => {
  console.error('\nfetch-tools failed:', e.message);
  process.exit(1);
});
