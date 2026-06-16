// Registers (or unregisters) the StreamGrabitel native messaging host with
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

const HOST_NAME = 'com.streamgrabitel.host';
// Pinned extension id, derived from manifest.json "key" (see scripts/gen-key.mjs).
const EXTENSION_ID = 'eogbccakibimjjinpjpbenjnmfgobegc';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const uninstall = process.argv.includes('--uninstall');
const home = os.homedir();

const launcher = process.platform === 'win32'
  ? join(ROOT, 'streamgrabitel-host.bat')
  : join(ROOT, 'streamgrabitel-host.sh');

const manifest = {
  name: HOST_NAME,
  description: 'StreamGrabitel download helper (yt-dlp + ffmpeg)',
  path: launcher,
  type: 'stdio',
  allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
};
const json = JSON.stringify(manifest, null, 2);

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
  const manifestPath = join(ROOT, `${HOST_NAME}.json`);
  writeFileSync(manifestPath, json);
  for (const key of WIN_REG_KEYS) {
    execFileSync('reg', ['add', key, '/ve', '/d', manifestPath, '/f'], { stdio: 'ignore' });
    console.log(`registered ${key}`);
  }
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
  rmSync(join(ROOT, `${HOST_NAME}.json`), { force: true });
}

function installPosix() {
  if (existsSync(launcher)) chmodSync(launcher, 0o755);
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
