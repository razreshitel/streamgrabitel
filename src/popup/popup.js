import { formatBytes } from '../lib/util.js';

const HOST = 'com.streamgrab.host';
const listEl = document.getElementById('list');
const clearBtn = document.getElementById('clear');
const pageBtn = document.getElementById('page');
const qualityEl = document.getElementById('quality');
const statusEl = document.getElementById('status');

let tab = null;
let pollTimer = null;

async function activeTab() {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t;
}

function kindLabel(item) {
  if (item.kind === 'hls') return 'HLS';
  if (item.kind === 'dash') return 'DASH';
  return (item.container || 'file').toUpperCase().slice(0, 5);
}

async function startDownload(item) {
  await chrome.runtime.sendMessage({ type: 'START_DOWNLOAD', item: { ...item, quality: qualityEl.value } });
  window.close();
}

function render(items) {
  listEl.textContent = '';
  document.body.classList.toggle('is-empty', items.length === 0);

  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'row';

    const badge = document.createElement('div');
    badge.className = `badge ${item.kind}`;
    badge.textContent = kindLabel(item);

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = item.name || item.host || item.url;

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = [item.host, item.size ? formatBytes(item.size) : '', item.kind !== 'direct' ? 'stream' : '']
      .filter(Boolean)
      .join(' · ');

    const dl = document.createElement('button');
    dl.className = 'dl';
    dl.textContent = 'Get';
    dl.addEventListener('click', () => startDownload(item));

    row.append(badge, name, meta, dl);
    listEl.appendChild(row);
  }
}

async function refresh() {
  if (!tab) tab = await activeTab();
  if (!tab) return;
  const res = await chrome.runtime.sendMessage({ type: 'GET_MEDIA', tabId: tab.id });
  render(res?.items || []);
}

// Download the page's main video (yt-dlp extracts it — this is the YouTube path).
pageBtn.addEventListener('click', async () => {
  if (!tab) tab = await activeTab();
  if (!tab?.url || !/^https?:/i.test(tab.url)) {
    statusEl.textContent = 'This page has no downloadable URL.';
    return;
  }
  await startDownload({
    id: crypto.randomUUID(),
    tabId: tab.id,
    url: tab.url,
    kind: 'page',
    name: tab.title || tab.url,
    host: new URL(tab.url).host,
  });
});

clearBtn.addEventListener('click', async () => {
  if (!tab) tab = await activeTab();
  await chrome.runtime.sendMessage({ type: 'CLEAR_TAB', tabId: tab.id });
  refresh();
});

// Probe the native host so the user knows whether the engine is installed.
function checkEngine() {
  let port;
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch {
    statusEl.textContent = 'engine: not installed — run npm run install-host';
    return;
  }
  let answered = false;
  port.onMessage.addListener((msg) => {
    if (msg.type === 'pong' || msg.type === 'ready') {
      if (msg.type === 'pong') {
        answered = true;
        statusEl.textContent = msg.ytdlp
          ? `engine: yt-dlp ${msg.ytdlp}${msg.ffmpeg ? ' + ffmpeg' : ''}`
          : 'engine: yt-dlp missing — run npm run fetch-tools';
        port.disconnect();
      } else {
        port.postMessage({ action: 'ping' });
      }
    }
  });
  port.onDisconnect.addListener(() => {
    if (!answered) {
      const err = chrome.runtime.lastError?.message || '';
      statusEl.textContent = /not found|forbidden/i.test(err)
        ? 'engine: not installed — run npm run install-host'
        : `engine: unavailable (${err || 'no response'})`;
    }
  });
}

refresh();
checkEngine();
pollTimer = setInterval(refresh, 1500);
window.addEventListener('unload', () => clearInterval(pollTimer));
