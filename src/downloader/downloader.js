// Drives a download through the StreamGrab native messaging host (yt-dlp + ffmpeg).
// The host writes the file straight to disk and streams progress back here, so
// there are no browser memory limits and YouTube/HLS/DASH/direct all work.

const HOST = 'com.streamgrab.host';
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

init();

async function init() {
  const id = new URLSearchParams(location.search).get('id');
  const data = await chrome.storage.session.get(`dl:${id}`);
  item = data[`dl:${id}`];
  if (!item) {
    $('title').textContent = 'Download not found';
    $('subtitle').textContent = 'The session expired — re-open it from the StreamGrab popup.';
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

function hostError() {
  finished = true;
  showWarn(
    'The local helper isn’t installed. In the streamgrab folder run:  npm run install-host  ' +
      '(and "npm run fetch-tools" once to get yt-dlp + ffmpeg), then reload the extension.',
  );
  setStatus('Native helper not found.', 'error');
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
