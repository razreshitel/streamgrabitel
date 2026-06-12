import { formatBytes } from '../lib/util.js';

const listEl = document.getElementById('list');
const countEl = document.getElementById('count');
const clearBtn = document.getElementById('clear');

let currentTabId = null;
let pollTimer = null;

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function kindLabel(item) {
  if (item.kind === 'hls') return 'HLS';
  if (item.kind === 'dash') return 'DASH';
  return (item.container || 'file').toUpperCase().slice(0, 5);
}

function render(items) {
  listEl.textContent = '';
  document.body.classList.toggle('is-empty', items.length === 0);
  countEl.textContent = items.length ? `${items.length} item${items.length > 1 ? 's' : ''}` : '';

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
    const bits = [item.host];
    if (item.size) bits.push(formatBytes(item.size));
    if (item.kind !== 'direct') bits.push('stream');
    meta.textContent = bits.filter(Boolean).join(' · ');

    const dl = document.createElement('button');
    dl.className = 'dl';
    dl.textContent = item.kind === 'direct' ? 'Save' : 'Get';
    dl.title = 'Open the downloader';
    dl.addEventListener('click', async () => {
      dl.disabled = true;
      dl.textContent = '…';
      await chrome.runtime.sendMessage({ type: 'START_DOWNLOAD', item });
      window.close();
    });

    row.append(badge, name, meta, dl);
    listEl.appendChild(row);
  }
}

async function refresh() {
  if (currentTabId == null) {
    const tab = await activeTab();
    currentTabId = tab?.id ?? null;
  }
  if (currentTabId == null) return;
  const res = await chrome.runtime.sendMessage({ type: 'GET_MEDIA', tabId: currentTabId });
  render(res?.items || []);
}

clearBtn.addEventListener('click', async () => {
  if (currentTabId == null) return;
  await chrome.runtime.sendMessage({ type: 'CLEAR_TAB', tabId: currentTabId });
  refresh();
});

refresh();
pollTimer = setInterval(refresh, 1500);
window.addEventListener('unload', () => clearInterval(pollTimer));
