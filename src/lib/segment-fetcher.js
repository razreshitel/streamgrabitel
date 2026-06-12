// Concurrent segment downloader with progress, retry, byte-range and
// optional AES-128 decryption. Returns the segment bytes in playlist order.

import { importAesKey, aesDecrypt } from './decrypt.js';
import { clamp } from './util.js';

export function concatChunks(chunks) {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

async function fetchBytes(url, byteRange, attempts = 3) {
  const headers = {};
  if (byteRange) headers.Range = `bytes=${byteRange.offset}-${byteRange.offset + byteRange.length - 1}`;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        credentials: 'include',
        cache: 'no-store',
        headers,
      });
      if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
  throw new Error(`Failed to fetch ${url}: ${lastErr?.message || 'unknown'}`);
}

/** Resolve AES-128 keys (cached by URI) into CryptoKey objects. */
async function resolveKey(key, keyCache) {
  if (!key || !key.uri) return null;
  if (key.method && key.method !== 'AES-128') {
    throw new Error(`Unsupported HLS encryption: ${key.method} (likely DRM — cannot download).`);
  }
  let ck = keyCache.get(key.uri);
  if (!ck) {
    const raw = await fetchBytes(key.uri, null);
    if (raw.byteLength !== 16) throw new Error('AES-128 key is not 16 bytes.');
    ck = await importAesKey(raw);
    keyCache.set(key.uri, ck);
  }
  return ck;
}

/**
 * @param {Array<{url:string, byteRange?:object, key?:object}>} segments
 * @param {{concurrency?:number, onProgress?:(done:number,total:number,bytes:number)=>void, signal?:AbortSignal}} opts
 * @returns {Promise<Uint8Array[]>} bytes per segment, in order
 */
export async function fetchSegments(segments, opts = {}) {
  const concurrency = clamp(opts.concurrency || 6, 1, 12);
  const onProgress = opts.onProgress || (() => {});
  const signal = opts.signal;
  const keyCache = new Map();

  const results = new Array(segments.length);
  let next = 0;
  let done = 0;
  let bytes = 0;

  async function worker() {
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const idx = next++;
      if (idx >= segments.length) return;
      const seg = segments[idx];
      let data = await fetchBytes(seg.url, seg.byteRange);
      if (seg.key) {
        const ck = await resolveKey(seg.key, keyCache);
        if (ck) data = await aesDecrypt(data, ck, seg.key.iv);
      }
      results[idx] = data;
      done++;
      bytes += data.byteLength;
      onProgress(done, segments.length, bytes);
    }
  }

  const pool = [];
  for (let i = 0; i < concurrency; i++) pool.push(worker());
  await Promise.all(pool);
  return results;
}
