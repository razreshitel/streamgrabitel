// Drives a download through the StreamGrabitel native messaging host (yt-dlp + ffmpeg).
// The host writes the file straight to disk and streams progress back here, so
// there are no browser memory limits and YouTube/HLS/DASH/direct all work.

import { formatDuration } from '../lib/util.js';

const HOST = 'com.streamgrabitel.host';
const $ = (id) => document.getElementById(id);

const optionsEl = $('options');
const go = $('go');
const warnEl = $('warn');
const logWrap = $('logWrap');
const logEl = $('log');
const qualityEl = $('quality');

let item = null;
let port = null;
let finished = false;
let lastFile = null;
let lastDir = null;

init();

async function init() {
  const id = new URLSearchParams(location.search).get('id');
  const data = await chrome.storage.session.get(`dl:${id}`);
  item = data[`dl:${id}`];
  // Consume it so session storage doesn't grow unbounded across downloads.
  chrome.storage.session.remove(`dl:${id}`);
  if (!item) {
    $('title').textContent = 'Download not found';
    $('subtitle').textContent = 'The session expired — re-open it from the StreamGrabitel popup.';
    return;
  }

  $('title').textContent = item.pageTitle || item.name || 'Download';
  $('subtitle').textContent = `${(item.kind || 'media').toUpperCase()} · ${item.host || ''}`;
  const a = $('reportUrl');
  a.textContent = item.host || item.url;
  a.href = item.pageUrl || item.url;

  if (item.quality) qualityEl.value = item.quality;

  go.disabled = false;
  go.textContent = 'Download';
  go.onclick = start;

  runPreview();
}

// --- preview (metadata only, before downloading) ----------------------------
function runPreview() {
  $('pmeta').textContent = 'Loading preview…';
  let pport;
  try {
    pport = chrome.runtime.connectNative(HOST);
  } catch {
    $('pmeta').textContent = '';
    return;
  }
  let answered = false;
  pport.onMessage.addListener((msg) => {
    if (msg.type === 'preview') {
      answered = true;
      renderPreview(msg);
      pport.disconnect();
    } else if (msg.type === 'previewError') {
      answered = true;
      $('pmeta').textContent = 'Preview unavailable — you can still download.';
      pport.disconnect();
    }
  });
  pport.onDisconnect.addListener(() => {
    if (!answered) $('pmeta').textContent = '';
  });
  pport.postMessage({ action: 'preview', url: item.url });
}

function renderPreview(info) {
  if (info.title) $('title').textContent = info.title;
  // Only load http(s) thumbnails — the URL comes from scraped page metadata.
  if (info.thumbnail && /^https?:\/\//i.test(info.thumbnail)) {
    const img = $('thumb');
    img.onload = () => ($('thumbWrap').hidden = false);
    img.onerror = () => ($('thumbWrap').hidden = true);
    img.src = info.thumbnail; // set src after handlers (cached images fire synchronously)
  }
  const bits = [];
  if (info.duration) bits.push(formatDuration(info.duration));
  if (info.uploader) bits.push(info.uploader);
  if (info.heights?.length) bits.push(`up to ${info.heights[0]}p`);
  if (info.extractor) bits.push(info.extractor);
  $('pmeta').textContent = bits.join('  ·  ');

  if (info.heights?.length) buildQualityOptions(info.heights);
}

// Replace the fixed presets with the resolutions this video actually offers.
function buildQualityOptions(heights) {
  const prev = qualityEl.value;
  qualityEl.innerHTML = '';
  const add = (v, label) => {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    qualityEl.appendChild(o);
  };
  add('best', 'Best (≤1080p · H.264)');
  for (const h of heights) add(String(h), `${h}p${h > 1080 ? ' · VP9/AV1' : ''}`);
  add('audio', 'Audio only (mp3)');
  if ([...qualityEl.options].some((o) => o.value === prev)) qualityEl.value = prev;
}

// --- ui helpers -------------------------------------------------------------
function setProgressWrap(show) {
  $('progressWrap').hidden = !show;
}
function setProgress(ratio) {
  const bar = $('bar');
  if (ratio == null) {
    bar.classList.add('indeterminate');
    bar.style.width = '';
  } else {
    bar.classList.remove('indeterminate');
    bar.style.width = `${Math.round(ratio * 100)}%`;
  }
}
function setStatus(text, cls = '') {
  const s = $('status');
  s.textContent = text;
  s.className = `status ${cls}`.trim();
}
function appendLog(line) {
  logEl.textContent += line + '\n';
  const lines = logEl.textContent.split('\n');
  if (lines.length > 600) logEl.textContent = lines.slice(-500).join('\n');
  logEl.scrollTop = logEl.scrollHeight;
}
function showWarn(text) {
  warnEl.hidden = false;
  warnEl.textContent = text;
}

// --- download ---------------------------------------------------------------
function start() {
  finished = false;
  $('doneActions').hidden = true;
  setControlsDisabled(true);
  setProgressWrap(true);
  setProgress(null);
  logWrap.hidden = false;
  setStatus('Connecting to the local helper…');

  try {
    port = chrome.runtime.connectNative(HOST);
  } catch (e) {
    return hostError(e.message);
  }

  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    if (finished) return;
    const err = chrome.runtime.lastError?.message || '';
    if (/not found|forbidden/i.test(err)) hostError(err);
    else fail(`Helper disconnected${err ? `: ${err}` : ''}.`);
  });

  port.postMessage({ action: 'download', url: item.url, quality: qualityEl.value });

  go.textContent = 'Cancel';
  go.disabled = false;
  go.onclick = cancel;
}

function onMessage(msg) {
  switch (msg.type) {
    case 'ready':
      break;
    case 'started':
      setStatus('Starting yt-dlp…');
      break;
    case 'progress':
      setProgress((msg.percent || 0) / 100);
      setStatus(`Downloading… ${msg.percent?.toFixed(1)}%${msg.speed ? ` · ${msg.speed}` : ''}${msg.eta ? ` · ETA ${msg.eta}` : ''}`);
      break;
    case 'log':
      appendLog(msg.line);
      break;
    case 'done':
      finished = true;
      setProgress(1);
      setStatus(`Done — saved to ${msg.file || msg.outDir}.`, 'done');
      lastFile = msg.file || null;
      lastDir = msg.outDir || null;
      $('doneActions').hidden = false;
      cleanup();
      endRun();
      break;
    case 'cancelled':
      finished = true;
      setStatus('Cancelled.');
      setProgress(0);
      $('bar').classList.remove('indeterminate');
      cleanup();
      endRun();
      break;
    case 'error':
      fail(msg.message + (msg.detail ? `\n${msg.detail}` : ''));
      break;
  }
}

function cancel() {
  try {
    port?.postMessage({ action: 'cancel' });
  } catch {
    /* already gone */
  }
  setStatus('Cancelling…');
}

function fail(message) {
  finished = true;
  setStatus(message.split('\n')[0], 'error');
  if (message.includes('\n')) appendLog(message);
  setProgress(0);
  $('bar').classList.remove('indeterminate');
  cleanup();
  endRun();
}

function hostError(detail) {
  finished = true;
  showWarn(
    'The local helper isn’t reachable. In the streamgrabitel folder run:  npm run install-host  ' +
      '(and "npm run fetch-tools" once to get yt-dlp + ffmpeg), then reload the extension.',
  );
  setStatus(`Native helper unavailable${detail ? `: ${detail}` : ''}.`, 'error');
  setProgress(0);
  $('bar').classList.remove('indeterminate');
  endRun();
}

function cleanup() {
  try {
    port?.disconnect();
  } catch {
    /* noop */
  }
  port = null;
}

function setControlsDisabled(disabled) {
  for (const s of optionsEl.querySelectorAll('select')) s.disabled = disabled;
}

function endRun() {
  setControlsDisabled(false);
  go.textContent = 'Download again';
  go.disabled = false;
  go.onclick = start;
}

// Ask the host to open the finished file / reveal it in the file manager.
function hostAction(action) {
  const file = lastFile || lastDir;
  if (!file) return;
  try {
    const p = chrome.runtime.connectNative(HOST);
    p.postMessage({ action, file });
    setTimeout(() => {
      try {
        p.disconnect();
      } catch {
        /* already closed */
      }
    }, 1500);
  } catch {
    /* host unavailable */
  }
}

$('openFile').addEventListener('click', () => hostAction('open'));
$('showFolder').addEventListener('click', () => hostAction('reveal'));
