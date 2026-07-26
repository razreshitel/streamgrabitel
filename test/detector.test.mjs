import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/background/detector.js';

const headers = (ct, len) => {
  const h = [];
  if (ct) h.push({ name: 'Content-Type', value: ct });
  if (len != null) h.push({ name: 'Content-Length', value: String(len) });
  return h;
};
const det = (url, opts = {}) => ({
  url,
  type: opts.type || 'xmlhttprequest',
  method: opts.method || 'GET',
  responseHeaders: headers(opts.ct, opts.len),
});

test('detects HLS by extension and content-type', () => {
  assert.equal(classify(det('https://x.com/a/playlist.m3u8')).kind, 'hls');
  assert.equal(classify(det('https://x.com/stream', { ct: 'application/vnd.apple.mpegurl' })).kind, 'hls');
});

test('detects DASH', () => {
  assert.equal(classify(det('https://x.com/a/manifest.mpd')).kind, 'dash');
});

test('detects a direct video file', () => {
  const r = classify(det('https://x.com/v.mp4', { type: 'media', ct: 'video/mp4', len: 5_000_000 }));
  assert.equal(r.kind, 'direct');
  assert.equal(r.container, 'mp4');
});

test('ignores stream segments', () => {
  assert.equal(classify(det('https://x.com/seg00001.ts')), null);
  assert.equal(classify(det('https://x.com/chunk.m4s')), null);
});

test('ignores non-GET (YouTube SABR is POST)', () => {
  assert.equal(classify(det('https://x.com/v.mp4', { method: 'POST', ct: 'video/mp4', len: 5_000_000 })), null);
});

test('ignores sub-50KB blobs even with a media name', () => {
  assert.equal(classify(det('https://x.com/v.mp4', { ct: 'video/mp4', len: 6000 })), null);
});

test('ignores UMP/protobuf chunk types', () => {
  assert.equal(classify(det('https://x.com/videoplayback', { ct: 'application/vnd.yt-ump' })), null);
});

test('ignores script endpoints mislabeled as media', () => {
  assert.equal(classify(det('https://x.com/remote_control.php', { ct: 'video/mp4', len: 5_000_000 })), null);
});

test('ignores opaque extensionless media names', () => {
  assert.equal(
    classify(det('https://x.com/Cu8HOny9tDgeXW6xDMr0-bl_mvt_eZxv-nSepKjO4Cs', { ct: 'video/mp4', len: 5_000_000 })),
    null,
  );
});

test('keeps recognizable extensionless media endpoints', () => {
  assert.equal(classify(det('https://x.com/videoplayback', { ct: 'video/mp4', len: 5_000_000 })).kind, 'direct');
});

test('ignores non-http and uninteresting resource types', () => {
  assert.equal(classify(det('data:video/mp4;base64,AAAA')), null);
  assert.equal(classify(det('https://x.com/v.mp4', { type: 'image', ct: 'video/mp4', len: 5_000_000 })), null);
});
