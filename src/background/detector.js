// Classifies an observed network response as downloadable media (or not).
// Pure logic so it can be unit-reasoned about independently of chrome.* APIs.

import { extOf } from '../lib/util.js';

// Direct, progressive media we can grab as-is.
const DIRECT_EXTS = new Set([
  'mp4', 'm4v', 'webm', 'mov', 'mkv', 'avi', 'flv', 'ogv',
  'm4a', 'mp3', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wav', 'weba',
]);

// Streaming manifests.
const HLS_EXTS = new Set(['m3u8', 'm3u']);
const DASH_EXTS = new Set(['mpd']);

// Per-segment artifacts of a stream — noise on their own, never listed directly.
const SEGMENT_EXTS = new Set(['ts', 'm4s', 'm4f', 'cmf', 'cmfv', 'cmfa', 'init', 'key', 'vtt']);

const HLS_CTYPES = new Set([
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
  'vnd.apple.mpegurl',
]);
const DASH_CTYPES = new Set(['application/dash+xml', 'video/vnd.mpeg.dash.mpd']);

// Content-types that mark a request as a stream *segment* (skip).
const SEGMENT_CTYPES = new Set([
  'video/mp2t',
  'video/iso.segment',
  'application/octet-stream', // ambiguous; only kept when the ext is clearly a full file
]);

// webRequest resource types worth inspecting.
const INTERESTING_TYPES = new Set(['media', 'xmlhttprequest', 'other', 'object', 'object_subrequest']);

function headerValue(headers, name) {
  if (!headers) return '';
  const h = headers.find((x) => x.name.toLowerCase() === name);
  return h ? (h.value || '').toLowerCase() : '';
}

/**
 * @returns {null | {kind:'hls'|'dash'|'direct', container:string, contentType:string, size:number}}
 */
export function classify(details) {
  const { url, type } = details;
  if (!url || !/^https?:/i.test(url)) return null;
  if (type && !INTERESTING_TYPES.has(type)) return null;

  const ext = extOf(url);
  const ctypeRaw = headerValue(details.responseHeaders, 'content-type');
  const ctype = ctypeRaw.split(';')[0].trim();
  const size = Number(headerValue(details.responseHeaders, 'content-length')) || 0;

  // --- streaming manifests -------------------------------------------------
  if (HLS_EXTS.has(ext) || HLS_CTYPES.has(ctype)) {
    return { kind: 'hls', container: 'm3u8', contentType: ctype, size };
  }
  if (DASH_EXTS.has(ext) || DASH_CTYPES.has(ctype)) {
    return { kind: 'dash', container: 'mpd', contentType: ctype, size };
  }

  // --- explicit stream segments: ignore ------------------------------------
  if (SEGMENT_EXTS.has(ext)) return null;
  if (SEGMENT_CTYPES.has(ctype) && !DIRECT_EXTS.has(ext)) return null;

  // --- direct progressive media -------------------------------------------
  const looksMedia =
    DIRECT_EXTS.has(ext) ||
    ctype.startsWith('video/') ||
    (ctype.startsWith('audio/') && !ctype.includes('mpegurl'));

  if (looksMedia) {
    // Skip obvious micro-segments that slipped through (range chunks, etc.).
    if (size && size < 50 * 1024 && !DIRECT_EXTS.has(ext)) return null;
    const container = DIRECT_EXTS.has(ext) ? ext : ctype.split('/')[1] || 'bin';
    return { kind: 'direct', container, contentType: ctype, size };
  }

  return null;
}

export { INTERESTING_TYPES };
