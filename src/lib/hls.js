// Minimal but practical HLS (m3u8) parser: master playlists, media playlists,
// fMP4 init segments (EXT-X-MAP), byte-ranges, and AES-128 keys.
// DRM (SAMPLE-AES / Widevine / FairPlay) is intentionally out of scope.

import { absolutize } from './util.js';

/** Parse `KEY=VALUE,KEY="v,v"` attribute lists, respecting quotes. */
function parseAttrs(str) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(str))) {
    let v = m[2];
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function parseByteRange(spec, prevEnd) {
  // "<length>[@<offset>]"
  const [lenStr, offStr] = spec.split('@');
  const length = Number(lenStr);
  const offset = offStr !== undefined ? Number(offStr) : prevEnd;
  return { offset, length, end: offset + length };
}

function hexToBytes(hex) {
  hex = hex.replace(/^0x/i, '');
  if (hex.length % 2) hex = '0' + hex;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/** Default AES-128 IV derived from the media sequence number (big-endian). */
function ivFromSeq(seq) {
  const iv = new Uint8Array(16);
  const dv = new DataView(iv.buffer);
  dv.setUint32(12, seq >>> 0);
  return iv;
}

export function isMasterPlaylist(text) {
  return /#EXT-X-STREAM-INF/.test(text);
}

/**
 * @returns {{isMaster:true, variants:Array, audioGroups:Object}}
 */
export function parseMaster(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const variants = [];
  const audioGroups = {}; // groupId -> [{name, language, uri, default, autoselect}]

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttrs(line.slice('#EXT-X-MEDIA:'.length));
      if (a.TYPE === 'AUDIO') {
        const g = a['GROUP-ID'] || 'default';
        (audioGroups[g] ||= []).push({
          name: a.NAME || a.LANGUAGE || 'audio',
          language: a.LANGUAGE || '',
          uri: a.URI ? absolutize(a.URI, baseUrl) : null, // null => muxed into video
          default: a.DEFAULT === 'YES',
          autoselect: a.AUTOSELECT === 'YES',
          channels: a.CHANNELS || '',
        });
      }
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttrs(line.slice('#EXT-X-STREAM-INF:'.length));
      // The URI is on the next non-comment line.
      let uri = '';
      for (let j = i + 1; j < lines.length; j++) {
        const nxt = lines[j].trim();
        if (!nxt || nxt.startsWith('#')) continue;
        uri = nxt;
        i = j;
        break;
      }
      if (!uri) continue;
      const res = a.RESOLUTION ? a.RESOLUTION.split('x').map(Number) : null;
      variants.push({
        url: absolutize(uri, baseUrl),
        bandwidth: Number(a.BANDWIDTH || a['AVERAGE-BANDWIDTH'] || 0),
        width: res ? res[0] : 0,
        height: res ? res[1] : 0,
        codecs: a.CODECS || '',
        frameRate: Number(a['FRAME-RATE'] || 0),
        audioGroup: a.AUDIO || null,
      });
    }
  }

  variants.sort((a, b) => b.bandwidth - a.bandwidth || b.height - a.height);
  return { isMaster: true, variants, audioGroups };
}

/**
 * @returns {{isMaster:false, segments:Array, initSegment:Object|null,
 *            targetDuration:number, totalDuration:number, encrypted:boolean}}
 */
export function parseMedia(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const segments = [];
  let initSegment = null;
  let targetDuration = 0;
  let totalDuration = 0;
  let mediaSeq = 0;
  let currentKey = null; // {method, uri, iv|null}
  let pendingDuration = 0;
  let pendingByteRange = null;
  let prevEnd = 0;
  let seq = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = Number(line.split(':')[1]) || 0;
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSeq = Number(line.split(':')[1]) || 0;
      seq = mediaSeq;
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const a = parseAttrs(line.slice('#EXT-X-KEY:'.length));
      if (a.METHOD === 'NONE') {
        currentKey = null;
      } else {
        currentKey = {
          method: a.METHOD, // AES-128 supported; others flagged downstream
          uri: a.URI ? absolutize(a.URI, baseUrl) : null,
          iv: a.IV ? hexToBytes(a.IV) : null,
        };
      }
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttrs(line.slice('#EXT-X-MAP:'.length));
      let br = null;
      if (a.BYTERANGE) br = parseByteRange(a.BYTERANGE, 0);
      initSegment = { url: absolutize(a.URI, baseUrl), byteRange: br };
    } else if (line.startsWith('#EXTINF:')) {
      pendingDuration = parseFloat(line.slice('#EXTINF:'.length)) || 0;
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingByteRange = parseByteRange(line.slice('#EXT-X-BYTERANGE:'.length), prevEnd);
    } else if (!line.startsWith('#')) {
      // a segment URI
      const url = absolutize(line, baseUrl);
      let br = pendingByteRange;
      if (br) prevEnd = br.end;
      const key = currentKey
        ? {
            method: currentKey.method,
            uri: currentKey.uri,
            iv: currentKey.iv || ivFromSeq(seq),
          }
        : null;
      segments.push({ url, duration: pendingDuration, byteRange: br, key });
      totalDuration += pendingDuration;
      pendingDuration = 0;
      pendingByteRange = null;
      seq++;
    }
  }

  const encrypted = segments.some((s) => s.key);
  return {
    isMaster: false,
    segments,
    initSegment,
    targetDuration,
    totalDuration,
    encrypted,
  };
}

/** Parse either kind; caller decides what to do with a master. */
export function parseHls(text, baseUrl) {
  return isMasterPlaylist(text) ? parseMaster(text, baseUrl) : parseMedia(text, baseUrl);
}
