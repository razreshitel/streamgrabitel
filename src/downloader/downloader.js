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
      setStatus(
        `Downloading… ${msg.percent?.toFixed(1)}%` +
          `${msg.total ? ` of ${msg.total}` : ''}${msg.speed ? ` · ${msg.speed}` : ''}${msg.eta ? ` · ETA ${msg.eta}` : ''}`,
      );
      break;
    case 'phase':
      setProgress(null); // indeterminate — post-processing has no % to report
      setStatus(`${phaseLabel(msg.name)}…`);
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
    case 'error': {
      const friendly = friendlyError(msg.detail || msg.message);
      fail(friendly || msg.message, msg.detail || '');
      break;
    }
  }
}

function phaseLabel(name) {
  if (name === 'Merger') return 'Merging audio + video';
  if (name === 'ExtractAudio') return 'Extracting audio';
  if (name === 'VideoConvertor' || name === 'VideoRemuxer') return 'Converting';
  if (name === 'EmbedSubtitle') return 'Embedding subtitles';
  if (name === 'Metadata') return 'Writing metadata';
  if (name && name.startsWith('Fixup')) return 'Finalizing';
  return 'Processing';
}

function cancel() {
  try {
    port?.postMessage({ action: 'cancel' });
  } catch {
    /* already gone */
  }
  setStatus('Cancelling…');
}

function fail(headline, detail = '') {
  finished = true;
  setStatus(headline, 'error');
  if (detail) appendLog(detail);
  setProgress(0);
  $('bar').classList.remove('indeterminate');
  cleanup();
  endRun();
}

// Turn common yt-dlp stderr into a plain-language, actionable message.
function friendlyError(text) {
  const d = (text || '').toLowerCase();
  if (/sign in to confirm|not a bot|confirm you.?re not a bot/.test(d))
    return 'YouTube wants a sign-in / bot check for this video. Try again shortly.';
  if (/requested format is not available/.test(d))
    return 'That quality isn’t available — try “Best available”.';
  if (/http error 429|too many requests/.test(d))
    return 'Rate-limited by the server — wait a moment and retry.';
  if (/http error 403|forbidden/.test(d))
    return 'The server blocked the request (403). Try again in a moment.';
  if (/private video|video unavailable|video is unavailable|members-only/.test(d))
    return 'This video is private, members-only, or unavailable.';
  if (/not available in your country|geo|in your location/.test(d))
    return 'This video is geo-blocked in your region.';
  if (/age.?restricted|confirm your age|inappropriate for some/.test(d))
    return 'Age-restricted video — it may require sign-in.';
  if (/drm|protected stream|protected content/.test(d))
    return 'This stream is DRM-protected and can’t be downloaded.';
  if (/unsupported url|unable to extract|no video formats|nothing to download/.test(d))
    return 'No downloadable video found on this page.';
  if (/ffmpeg|postprocess/.test(d))
    return 'Conversion failed — is ffmpeg installed? Run “npm run fetch-tools”.';
  return null;
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
