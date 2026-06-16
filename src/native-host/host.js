// StreamGrabitel native messaging host.
// Chrome launches this (via streamgrabitel-host.bat) and talks to it over stdio using
// the native-messaging framing: a 4-byte little-endian length prefix + UTF-8 JSON.
// It bridges the extension to local yt-dlp + ffmpeg binaries — that's what lets
// StreamGrabitel handle YouTube and large files without any in-browser limits.

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
// Deno lets yt-dlp solve YouTube's JS challenges (avoids 403s / missing formats).
const DENO = fs.existsSync(path.join(BIN, 'deno' + EXE)) ? path.join(BIN, 'deno' + EXE) : null;

// Shared yt-dlp args: point it at our bundled JS runtime when present.
function jsRuntimeArgs() {
  return DENO ? ['--js-runtimes', `deno:${DENO}`] : [];
}

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
let cancelRequested = false;

// yt-dlp spawns ffmpeg as a child; proc.kill() leaves it orphaned on Windows.
// Kill the whole tree so nothing keeps holding the output file.
function killTree(proc) {
  if (!proc) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F']);
    } catch {
      /* already gone */
    }
  } else {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

// Reveal a file in the OS file manager (selecting it), or open a folder.
function revealPath(p) {
  if (!p) return;
  let isDir = false;
  try {
    isDir = fs.statSync(p).isDirectory();
  } catch {
    /* path may be gone */
  }
  try {
    if (process.platform === 'win32') {
      if (isDir) spawn('explorer.exe', [p], { windowsHide: true });
      else spawn('explorer.exe', [`/select,${p}`], { windowsHide: true });
    } else if (process.platform === 'darwin') {
      spawn('open', isDir ? [p] : ['-R', p]);
    } else {
      spawn('xdg-open', [isDir ? p : path.dirname(p)]);
    }
  } catch {
    /* nothing we can do */
  }
}

// Open a file with its default application (no console window on Windows).
function openPath(p) {
  if (!p) return;
  try {
    if (process.platform === 'win32') spawn('rundll32', ['url.dll,FileProtocolHandler', p], { windowsHide: true });
    else if (process.platform === 'darwin') spawn('open', [p]);
    else spawn('xdg-open', [p]);
  } catch {
    /* nothing we can do */
  }
}

function handle(msg) {
  switch (msg.action) {
    case 'ping':
      return ping();
    case 'preview':
      return preview(msg);
    case 'download':
      return download(msg);
    case 'cancel':
      cancelRequested = true;
      killTree(current);
      return;
    case 'reveal':
      return revealPath(msg.file);
    case 'open':
      return openPath(msg.file);
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
    send({ type: 'pong', ytdlp: code === 0 ? ver.trim() : null, ffmpeg: !!FFMPEG_DIR, deno: !!DENO, bin: BIN }),
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
    proc = spawn(YTDLP, ['-J', '--no-playlist', '--no-warnings', ...jsRuntimeArgs(), '--', url], { windowsHide: true });
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

// Force H.264 (avc1) video + AAC audio in an mp4. YouTube also serves VP9/AV1
// inside mp4 containers, which many players (incl. Windows' default) render as a
// grey screen with sound — so we match the *codec*, not just the container.
// avc1 caps at 1080p on YouTube; above that the chosen height falls back to
// whatever codec is available (may be VP9/AV1 — the user explicitly asked for it).
const QUALITY = {
  best: ['-f', 'bv*[vcodec^=avc1]+ba[acodec^=mp4a]/b[vcodec^=avc1]/bv*+ba/b', '--merge-output-format', 'mp4'],
  audio: ['-x', '--audio-format', 'mp3'],
};

// 'best' | 'audio' | a numeric height ('1080', '720', '2160', …).
function qualityArgs(q) {
  if (q === 'audio') return QUALITY.audio;
  const h = parseInt(q, 10);
  if (Number.isFinite(h) && h > 0) {
    return [
      '-f',
      `bv*[height<=${h}][vcodec^=avc1]+ba[acodec^=mp4a]/b[height<=${h}][vcodec^=avc1]/bv*[height<=${h}]+ba/b[height<=${h}]`,
      '--merge-output-format',
      'mp4',
    ];
  }
  return QUALITY.best;
}

function download(msg) {
  if (current) return send({ type: 'error', message: 'A download is already running.' });
  cancelRequested = false;

  const url = String(msg.url || '');
  if (!/^https?:\/\//i.test(url)) return send({ type: 'error', message: 'Invalid or missing URL.' });

  const outDir = downloadsDir();
  const args = [
    '--newline',
    '--no-playlist',
    '--no-mtime',
    '--no-part',
    '--windows-filenames', // sanitize reserved/invalid names so metadata can't steer the path
    '-P',
    outDir, // fixed download root, independent of the (metadata-driven) name template
    '-o',
    '%(title).180B [%(id)s].%(ext)s',
    ...qualityArgs(msg.quality),
  ];
  if (FFMPEG_DIR) args.push('--ffmpeg-location', FFMPEG_DIR);
  args.push(...jsRuntimeArgs());
  args.push('--', url); // end-of-options: never treat the URL as a flag

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
    if (cancelRequested) send({ type: 'cancelled' });
    else if (code === 0) send({ type: 'done', file: finalFile, outDir });
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
