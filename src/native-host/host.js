// StreamGrab native messaging host.
// Chrome launches this (via streamgrab-host.bat) and talks to it over stdio using
// the native-messaging framing: a 4-byte little-endian length prefix + UTF-8 JSON.
// It bridges the extension to local yt-dlp + ffmpeg binaries — that's what lets
// StreamGrab handle YouTube and large files without any in-browser limits.

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HOST_DIR, '..', '..');
const BIN = path.join(REPO_ROOT, 'bin');
const EXE = process.platform === 'win32' ? '.exe' : '';

// Prefer bundled binaries in bin/, fall back to whatever is on PATH.
function toolPath(name) {
  const local = path.join(BIN, name + EXE);
  return fs.existsSync(local) ? local : name;
}
const YTDLP = toolPath('yt-dlp');
const HAS_LOCAL_YTDLP = YTDLP !== 'yt-dlp';
const FFMPEG_DIR = fs.existsSync(path.join(BIN, 'ffmpeg' + EXE)) ? BIN : null;

// The Downloads folder can be relocated (e.g. to another drive or OneDrive), so
// "homedir/Downloads" is only a guess. On Windows, read the real known-folder
// path from the registry; fall back to the guess, then the home folder.
function downloadsDir() {
  if (process.platform === 'win32') {
    try {
      const out = execFileSync(
        'reg',
        [
          'query',
          'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders',
          '/v',
          '{374DE290-123F-4565-9164-39C4925E467B}',
        ],
        { encoding: 'utf8' },
      );
      const m = out.match(/REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m);
      if (m) {
        const p = m[1].replace(/%([^%]+)%/g, (_, v) => process.env[v] || `%${v}%`);
        if (fs.existsSync(p)) return p;
      }
    } catch {
      /* fall through to the heuristic */
    }
  }
  const d = path.join(os.homedir(), 'Downloads');
  return fs.existsSync(d) ? d : os.homedir();
}

// --- native messaging IO ----------------------------------------------------
function send(msg) {
  const json = Buffer.from(JSON.stringify(msg), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([header, json]));
}

let inbuf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  inbuf = Buffer.concat([inbuf, chunk]);
  while (inbuf.length >= 4) {
    const len = inbuf.readUInt32LE(0);
    if (inbuf.length < 4 + len) break;
    const body = inbuf.subarray(4, 4 + len);
    inbuf = inbuf.subarray(4 + len);
    let msg;
    try {
      msg = JSON.parse(body.toString('utf8'));
    } catch {
      continue;
    }
    handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));

// --- request handling -------------------------------------------------------
let current = null;

function handle(msg) {
  switch (msg.action) {
    case 'ping':
      return ping();
    case 'preview':
      return preview(msg);
    case 'download':
      return download(msg);
    case 'cancel':
      if (current) current.kill();
      return;
    default:
      send({ type: 'error', message: `unknown action: ${msg.action}` });
  }
}

function ping() {
  let ver = '';
  let proc;
  try {
    proc = spawn(YTDLP, ['--version']);
  } catch {
    return send({ type: 'pong', ytdlp: null, ffmpeg: !!FFMPEG_DIR });
  }
  proc.stdout.on('data', (d) => (ver += d));
  proc.on('error', () => send({ type: 'pong', ytdlp: null, ffmpeg: !!FFMPEG_DIR }));
  proc.on('close', (code) =>
    send({ type: 'pong', ytdlp: code === 0 ? ver.trim() : null, ffmpeg: !!FFMPEG_DIR, bin: BIN }),
  );
}

// Fetch metadata only (no download) so the UI can show a preview first.
function preview(msg) {
  const url = String(msg.url || '');
  if (!/^https?:\/\//i.test(url)) return send({ type: 'previewError', message: 'Invalid URL.' });

  let out = '';
  let err = '';
  let proc;
  try {
    proc = spawn(YTDLP, ['-J', '--no-playlist', '--no-warnings', url], { windowsHide: true });
  } catch (e) {
    return send({ type: 'previewError', message: `Could not launch yt-dlp: ${e.message}` });
  }
  proc.stdout.on('data', (d) => (out += d));
  proc.stderr.on('data', (d) => (err += d));
  proc.on('error', (e) => send({ type: 'previewError', message: e.message }));
  proc.on('close', (code) => {
    if (code !== 0) {
      return send({ type: 'previewError', message: 'yt-dlp could not read this page.', detail: err.slice(-400) });
    }
    try {
      const info = JSON.parse(out);
      // Only forward small fields — a full -J dump can exceed the native-messaging size limit.
      send({
        type: 'preview',
        title: info.title || info.fulltitle || '',
        thumbnail: info.thumbnail || '',
        duration: info.duration || 0,
        uploader: info.uploader || info.channel || info.uploader_id || '',
        extractor: info.extractor_key || info.extractor || '',
        heights: summarizeHeights(info.formats),
      });
    } catch {
      send({ type: 'previewError', message: 'Could not parse the video info.' });
    }
  });
}

// Distinct video resolutions available, highest first.
function summarizeHeights(formats) {
  if (!Array.isArray(formats)) return [];
  const hs = new Set();
  for (const f of formats) {
    if (f && f.vcodec && f.vcodec !== 'none' && f.height) hs.add(f.height);
  }
  return [...hs].sort((a, b) => b - a).slice(0, 16);
}

// Prefer H.264 video + AAC audio in an mp4 — universally playable (Windows'
// default player can't handle VP9/AV1). Fall back to any best video+audio.
const QUALITY = {
  best: ['-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b', '--merge-output-format', 'mp4'],
  '1080': [
    '-f',
    'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/bv*[height<=1080]+ba/b[height<=1080]',
    '--merge-output-format',
    'mp4',
  ],
  '720': [
    '-f',
    'bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720][ext=mp4]/bv*[height<=720]+ba/b[height<=720]',
    '--merge-output-format',
    'mp4',
  ],
  audio: ['-x', '--audio-format', 'mp3'],
};

function download(msg) {
  if (current) return send({ type: 'error', message: 'A download is already running.' });

  const url = String(msg.url || '');
  if (!/^https?:\/\//i.test(url)) return send({ type: 'error', message: 'Invalid or missing URL.' });

  const outDir = downloadsDir();
  const args = [
    '--newline',
    '--no-playlist',
    '--no-mtime',
    '--no-part',
    '-o',
    path.join(outDir, '%(title).180B [%(id)s].%(ext)s'),
    ...(QUALITY[msg.quality] || QUALITY.best),
  ];
  if (FFMPEG_DIR) args.push('--ffmpeg-location', FFMPEG_DIR);
  args.push(url);

  send({ type: 'started', url, outDir, ytdlp: YTDLP });

  let proc;
  try {
    proc = spawn(YTDLP, args, { windowsHide: true });
  } catch (e) {
    return send({ type: 'error', message: `Could not launch yt-dlp: ${e.message}` });
  }
  current = proc;

  let finalFile = null;
  let stderrTail = '';

  const onLine = (line) => {
    const pm = line.match(/\[download\]\s+([\d.]+)%/);
    if (pm) {
      const sp = line.match(/at\s+([\d.]+\s*\w+\/s)/);
      const eta = line.match(/ETA\s+([\d:]+)/);
      send({ type: 'progress', percent: parseFloat(pm[1]), speed: sp ? sp[1] : '', eta: eta ? eta[1] : '' });
    }
    const dest =
      line.match(/Merging formats into "(.+)"/) ||
      line.match(/\[ExtractAudio\] Destination:\s*(.+)\s*$/) ||
      line.match(/\[download\] Destination:\s*(.+)\s*$/);
    if (dest) finalFile = dest[1].replace(/"$/, '').trim();
    const already = line.match(/\[download\]\s+(.+?)\s+has already been downloaded/);
    if (already) finalFile = already[1].trim();
    send({ type: 'log', line });
  };

  lineStream(proc.stdout, onLine);
  lineStream(proc.stderr, (l) => {
    stderrTail = `${stderrTail}\n${l}`.slice(-2000);
    onLine(l);
  });

  proc.on('error', (e) => {
    current = null;
    const hint = HAS_LOCAL_YTDLP ? '' : ' — yt-dlp not found. Run "npm run fetch-tools".';
    send({ type: 'error', message: `yt-dlp failed to start: ${e.message}${hint}` });
  });
  proc.on('close', (code) => {
    current = null;
    if (code === 0) send({ type: 'done', file: finalFile, outDir });
    else send({ type: 'error', message: `yt-dlp exited with code ${code}.`, detail: stderrTail.trim() });
  });
}

// Split a stream into trimmed lines (handles \r, \n, \r\n — yt-dlp uses \r a lot).
function lineStream(stream, cb) {
  let acc = '';
  stream.setEncoding('utf8');
  stream.on('data', (d) => {
    acc += d;
    let i;
    while ((i = acc.search(/\r\n|\r|\n/)) >= 0) {
      const line = acc.slice(0, i);
      acc = acc.slice(i + (acc[i] === '\r' && acc[i + 1] === '\n' ? 2 : 1));
      if (line.trim()) cb(line);
    }
  });
  stream.on('end', () => {
    if (acc.trim()) cb(acc);
  });
}

send({ type: 'ready', platform: process.platform, ytdlp: HAS_LOCAL_YTDLP ? 'bundled' : 'path', ffmpeg: !!FFMPEG_DIR });
