// StreamGrab background service worker (MV3).
// Observes network responses, classifies media, keeps a per-tab catalogue,
// drives the toolbar badge, and answers the popup / opens the downloader.

import { classify } from './detector.js';
import { uid, basename, hostOf } from '../lib/util.js';

const MAX_PER_TAB = 60;
const BADGE_COLOR = '#4F46E5';

// tabId -> Map<url, item>
/** @type {Map<number, Map<string, any>>} */
const store = new Map();

// --- session persistence (survives SW suspend/resume) -----------------------
let loaded = false;
async function ensureLoaded() {
  if (loaded) return;
  try {
    const { media } = await chrome.storage.session.get('media');
    if (media) {
      for (const [tabId, items] of Object.entries(media)) {
        const m = new Map();
        for (const it of items) m.set(it.url, it);
        store.set(Number(tabId), m);
      }
    }
  } catch {
    /* first run — nothing to load */
  }
  loaded = true;
}

let persistTimer = null;
function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    const media = {};
    for (const [tabId, m] of store) media[tabId] = [...m.values()];
    try {
      await chrome.storage.session.set({ media });
    } catch {
      /* ignore quota / suspended */
    }
  }, 400);
}

function tabItems(tabId) {
  let m = store.get(tabId);
  if (!m) {
    m = new Map();
    store.set(tabId, m);
  }
  return m;
}

async function setBadge(tabId) {
  const n = store.get(tabId)?.size || 0;
  try {
    await chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' });
  } catch {
    /* tab gone */
  }
}

function clearTab(tabId) {
  if (store.has(tabId)) {
    store.delete(tabId);
    schedulePersist();
  }
  setBadge(tabId);
}

// --- detection --------------------------------------------------------------
async function onResponse(details) {
  if (details.tabId < 0) return; // not attached to a tab (e.g. SW fetch)
  const hit = classify(details);
  if (!hit) return;

  await ensureLoaded();
  const m = tabItems(details.tabId);

  const existing = m.get(details.url);
  if (existing) {
    if (hit.size && !existing.size) existing.size = hit.size;
    return;
  }
  if (m.size >= MAX_PER_TAB) return;

  m.set(details.url, {
    id: uid(),
    tabId: details.tabId,
    url: details.url,
    kind: hit.kind, // 'hls' | 'dash' | 'direct'
    container: hit.container,
    contentType: hit.contentType,
    size: hit.size,
    name: basename(details.url) || hostOf(details.url),
    host: hostOf(details.url),
    ts: Date.now(),
  });

  schedulePersist();
  setBadge(details.tabId);
}

chrome.webRequest.onResponseStarted.addListener(
  onResponse,
  { urls: ['<all_urls>'] },
  ['responseHeaders'],
);

// Reset a tab's catalogue when it navigates to a new top-level page.
chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.type === 'main_frame' && d.tabId >= 0) clearTab(d.tabId);
  },
  { urls: ['<all_urls>'] },
);

chrome.tabs.onRemoved.addListener((tabId) => clearTab(tabId));

// --- messaging --------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    await ensureLoaded();
    if (msg.type === 'GET_MEDIA') {
      const m = store.get(msg.tabId);
      const items = m ? [...m.values()].sort((a, b) => b.ts - a.ts) : [];
      sendResponse({ items });
      return;
    }
    if (msg.type === 'CLEAR_TAB') {
      clearTab(msg.tabId);
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'START_DOWNLOAD') {
      const item = { ...msg.item };
      // Enrich with page context for a nicer default filename.
      try {
        const tab = await chrome.tabs.get(item.tabId);
        item.pageTitle = tab?.title || '';
        item.pageUrl = tab?.url || '';
      } catch {
        /* tab may be gone */
      }
      await chrome.storage.session.set({ [`dl:${item.id}`]: item });
      await chrome.tabs.create({
        url: chrome.runtime.getURL(`src/downloader/downloader.html?id=${item.id}`),
      });
      sendResponse({ ok: true });
      return;
    }
    sendResponse({ error: 'unknown message' });
  })();
  return true; // async response
});

// --- lifecycle --------------------------------------------------------------
chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
});
chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
