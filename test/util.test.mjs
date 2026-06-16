import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatBytes, formatDuration, extOf, hostOf, basename } from '../src/lib/util.js';

test('formatBytes', () => {
  assert.equal(formatBytes(0), '');
  assert.equal(formatBytes(500), '500 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1048576), '1.0 MB');
});

test('formatDuration', () => {
  assert.equal(formatDuration(0), '');
  assert.equal(formatDuration(65), '1:05');
  assert.equal(formatDuration(3661), '1:01:01');
});

test('extOf', () => {
  assert.equal(extOf('https://x.com/a.MP4?q=1'), 'mp4');
  assert.equal(extOf('https://x.com/a/b.m3u8'), 'm3u8');
  assert.equal(extOf('https://x.com/novideo'), '');
});

test('hostOf', () => {
  assert.equal(hostOf('https://host.example/x/y'), 'host.example');
  assert.equal(hostOf('not a url'), '');
});

test('basename', () => {
  assert.equal(basename('https://x.com/a/b%20c.mp4'), 'b c.mp4');
});
