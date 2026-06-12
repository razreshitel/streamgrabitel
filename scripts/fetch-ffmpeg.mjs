// Downloads the ffmpeg.wasm single-threaded core + the 0.12 worker wrapper into
// vendor/ffmpeg/ with stable filenames the extension references directly.
//
// We use the SINGLE-THREADED core on purpose: it does NOT need SharedArrayBuffer
// / cross-origin isolation (COOP+COEP), which is awkward to obtain inside a
// Manifest V3 extension page. Slower than the MT core, but it "just loads".
//
// Run: npm run ffmpeg   (or npm run setup)

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const FFMPEG_VERSION = '0.12.10'; // @ffmpeg/ffmpeg (loader + worker wrapper)
const CORE_VERSION = '0.12.6'; //   @ffmpeg/core   (ffmpeg-core.js + .wasm)

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'vendor', 'ffmpeg');
const CDN = 'https://cdn.jsdelivr.net/npm';
const FLAT = 'https://data.jsdelivr.com/v1/package/npm';

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  console.log(`  ${dest.replace(ROOT, '.').replace(/\\/g, '/')}  (${(buf.length / 1024).toFixed(0)} KiB)`);
}

async function main() {
  mkdirSync(OUT, { recursive: true });

  // The 0.12 loader spins up a worker that lives in a hashed chunk such as
  // "814.ffmpeg.js". The exact number can change between releases, so resolve it
  // from the published file list instead of hard-coding it.
  console.log(`Resolving @ffmpeg/ffmpeg@${FFMPEG_VERSION} file list...`);
  const flat = await getJson(`${FLAT}/@ffmpeg/ffmpeg@${FFMPEG_VERSION}/flat`);
  const names = flat.files.map((f) => f.name);
  const workerName = names.find((n) => /\/dist\/umd\/\d+\.ffmpeg\.js$/.test(n));
  if (!workerName) {
    throw new Error('Could not find the umd worker chunk (NNN.ffmpeg.js) in the package listing.');
  }
  console.log(`  worker chunk: ${workerName}`);

  console.log('Downloading...');
  await download(`${CDN}/@ffmpeg/ffmpeg@${FFMPEG_VERSION}/dist/umd/ffmpeg.js`, join(OUT, 'ffmpeg.js'));
  await download(`${CDN}/@ffmpeg/ffmpeg@${FFMPEG_VERSION}${workerName}`, join(OUT, 'ffmpeg-worker.js'));
  await download(`${CDN}/@ffmpeg/core@${CORE_VERSION}/dist/umd/ffmpeg-core.js`, join(OUT, 'ffmpeg-core.js'));
  await download(`${CDN}/@ffmpeg/core@${CORE_VERSION}/dist/umd/ffmpeg-core.wasm`, join(OUT, 'ffmpeg-core.wasm'));

  writeFileSync(
    join(OUT, 'VERSION.txt'),
    `@ffmpeg/ffmpeg ${FFMPEG_VERSION}\n@ffmpeg/core ${CORE_VERSION}\nworker: ${workerName}\n`,
  );

  console.log('\nffmpeg.wasm ready in vendor/ffmpeg/.');
}

main().catch((err) => {
  console.error('\nFailed to fetch ffmpeg.wasm:', err.message);
  console.error('Check your network/proxy and try again.');
  process.exit(1);
});
