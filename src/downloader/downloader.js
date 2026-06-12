import { parseHls } from '../lib/hls.js';
import { parseDash } from '../lib/dash.js';
import { fetchSegments, concatChunks } from '../lib/segment-fetcher.js';
import { muxToMp4 } from '../lib/ffmpeg-runner.js';
import { formatBytes, formatDuration, sanitizeFilename, extOf } from '../lib/util.js';

const FF_BASE = chrome.runtime.getURL('vendor/ffmpeg/');
const $ = (id) => document.getElementById(id);

const optionsEl = $('options');
const go = $('go');
const warnEl = $('warn');
const logWrap = $('logWrap');
const logEl = $('log');

let item = null;
let abort = null;

// per-kind UI state
let hlsMaster = null;
let videoSelect = null;
let audioSelect = null;
let audioField = null;
let dashData = null;
let dashVideoSelect = null;
let dashAudioSelect = null;

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
  renderHeader();

  if ((item.kind === 'hls' || item.kind === 'dash') && !self.FFmpegWASM) {
    showWarn(
      'ffmpeg.wasm isn’t bundled yet. Run “npm run setup” in the streamgrab folder, then reload the extension — streaming downloads need it to produce an MP4.',
    );
  }

  if (item.kind === 'direct') setupDirect();
  else if (item.kind === 'hls') setupHls();
  else if (item.kind === 'dash') setupDash();
}

// ---------------------------------------------------------------- header / ui
function renderHeader() {
  $('title').textContent = item.pageTitle || item.name || 'Download';
  $('subtitle').textContent = `${item.kind.toUpperCase()} · ${item.host}`;
  const a = $('reportUrl');
  a.textContent = item.host;
  a.href = item.pageUrl || item.url;
}

function showWarn(text) {
  warnEl.hidden = false;
  warnEl.textContent = text;
}

function makeSelectField(labelText) {
  const field = document.createElement('div');
  field.className = 'field';
  const label = document.createElement('label');
  label.textContent = labelText;
  const select = document.createElement('select');
  field.append(label, select);
  return { field, select };
}

function makeInfoField(labelText, text) {
  const field = document.createElement('div');
  field.className = 'field';
  const label = document.createElement('label');
  label.textContent = labelText;
  const info = document.createElement('div');
  info.className = 'fileinfo';
  info.textContent = text;
  field.append(label, info);
  return field;
}

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
  if (lines.length > 500) logEl.textContent = lines.slice(-400).join('\n');
  logEl.scrollTop = logEl.scrollHeight;
}

function fail(msg) {
  const cancelled = /cancel/i.test(msg) || /abort/i.test(msg);
  setStatus(cancelled ? 'Cancelled.' : msg, cancelled ? '' : 'error');
  setProgress(0);
  $('bar').classList.remove('indeterminate');
}

// ------------------------------------------------------------------- fetching
async function fetchText(url) {
  const res = await fetch(url, { credentials: 'include', cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status} loading ${url}`);
  return res.text();
}

async function grabTrack(segObjs, label) {
  setStatus(`Downloading ${label}… 0/${segObjs.length}`);
  const parts = await fetchSegments(segObjs, {
    concurrency: 6,
    signal: abort?.signal,
    onProgress: (done, total, bytes) => {
      setProgress(done / total);
      setStatus(`Downloading ${label}… ${done}/${total} (${formatBytes(bytes)})`);
    },
  });
  return concatChunks(parts);
}

function withInit(initObj, segObjs) {
  return initObj ? [{ url: initObj.url, byteRange: initObj.byteRange || null }, ...segObjs] : segObjs;
}

function withInitUrls(initUrl, urls) {
  const segs = urls.map((u) => ({ url: u }));
  return initUrl ? [{ url: initUrl }, ...segs] : segs;
}

function checkEncryption(media) {
  const methods = new Set((media.segments || []).map((s) => s.key && s.key.method).filter(Boolean));
  for (const m of methods) {
    if (m !== 'AES-128') {
      throw new Error(`This stream uses ${m} encryption (DRM) and cannot be downloaded.`);
    }
  }
}

function hlsExt(initObj, firstSegUrl) {
  if (initObj) return 'mp4';
  const e = extOf(firstSegUrl || '');
  return ['m4s', 'mp4', 'm4f', 'cmfv', 'cmfa'].includes(e) ? 'mp4' : 'ts';
}

function dashExt(rep) {
  return (rep.mimeType || '').includes('webm') ? 'webm' : 'mp4';
}

// -------------------------------------------------------------------- saving
function save(bytes, filename, mime = 'video/mp4') {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, saveAs: true }, () => {
    if (chrome.runtime.lastError) setStatus(`Download error: ${chrome.runtime.lastError.message}`, 'error');
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  });
}

async function muxAndSave(video, audio) {
  setStatus('Muxing to MP4 with ffmpeg.wasm… (first run loads the ~30 MB core)');
  setProgress(0);
  logWrap.hidden = false;
  const mp4 = await muxToMp4({
    video,
    audio,
    base: FF_BASE,
    onLog: appendLog,
    onProgress: (r) => setProgress(r),
  });
  const filename = sanitizeFilename(item.pageTitle || item.name || 'video') + '.mp4';
  save(mp4, filename);
  setProgress(1);
  setStatus(`Done — ${filename} (${formatBytes(mp4.length)}). Pick where to save it.`, 'done');
}

// ------------------------------------------------------------- run lifecycle
function setControlsDisabled(disabled) {
  for (const s of optionsEl.querySelectorAll('select')) s.disabled = disabled;
}

function startRun() {
  abort = new AbortController();
  setControlsDisabled(true);
  setProgressWrap(true);
  logWrap.hidden = false;
  go.textContent = 'Cancel';
  go.disabled = false;
  go.onclick = () => {
    abort.abort();
    setStatus('Cancelling…');
  };
}

function endRun() {
  setControlsDisabled(false);
  go.textContent = 'Start over';
  go.disabled = false;
  go.onclick = () => location.reload();
}

// -------------------------------------------------------------------- DIRECT
function setupDirect() {
  optionsEl.appendChild(
    makeInfoField(
      'Direct file',
      `${(item.container || 'file').toUpperCase()} · ${item.size ? formatBytes(item.size) : 'size unknown'} · ${item.host}`,
    ),
  );
  go.textContent = 'Save file';
  go.disabled = false;
  go.onclick = () => {
    go.disabled = true;
    setProgressWrap(true);
    setProgress(null);
    setStatus('Saving via browser downloads…');
    const ext = item.container && item.container.length <= 4 ? item.container : extOf(item.url) || 'mp4';
    const filename = sanitizeFilename(item.pageTitle || item.name || 'video') + '.' + ext;
    chrome.downloads.download({ url: item.url, filename, saveAs: true }, () => {
      if (chrome.runtime.lastError) {
        setStatus(`Download error: ${chrome.runtime.lastError.message}`, 'error');
        go.disabled = false;
      } else {
        setProgress(1);
        setStatus(`Saving ${filename}…`, 'done');
      }
    });
  };
}

// ----------------------------------------------------------------------- HLS
function variantLabel(v) {
  const q = v.height ? `${v.height}p` : v.bandwidth ? `${Math.round(v.bandwidth / 1000)} kbps` : 'variant';
  const fps = v.frameRate ? ` ${Math.round(v.frameRate)}fps` : '';
  const bw = v.bandwidth ? ` · ${formatBytes(v.bandwidth / 8)}/s` : '';
  const codec = v.codecs ? ` · ${v.codecs.split(',')[0]}` : '';
  return `${q}${fps}${bw}${codec}`;
}

function updateHlsAudio() {
  const group = videoSelect.selectedOptions[0]?.dataset.group || '';
  const renditions = (hlsMaster.audioGroups[group] || []).filter((r) => r.uri);
  audioSelect.textContent = '';
  if (renditions.length === 0) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = 'Muxed in video (no separate track)';
    audioSelect.appendChild(o);
    audioSelect.disabled = true;
    audioField.style.opacity = 0.6;
    return;
  }
  audioSelect.disabled = false;
  audioField.style.opacity = 1;
  renditions.forEach((r) => {
    const o = document.createElement('option');
    o.value = r.uri;
    o.textContent = `${r.name || 'audio'}${r.language ? ` (${r.language})` : ''}${r.default ? ' — default' : ''}`;
    audioSelect.appendChild(o);
  });
  const def = renditions.findIndex((r) => r.default);
  if (def >= 0) audioSelect.selectedIndex = def;
}

async function setupHls() {
  setProgressWrap(true);
  setProgress(null);
  setStatus('Loading HLS playlist…');
  let parsed;
  try {
    parsed = parseHls(await fetchText(item.url), item.url);
  } catch (e) {
    return fail(`Could not load playlist: ${e.message}`);
  }
  setProgressWrap(false);

  if (parsed.isMaster) {
    if (parsed.variants.length === 0) return fail('Master playlist had no variants.');
    hlsMaster = parsed;

    const vf = makeSelectField('Quality');
    videoSelect = vf.select;
    parsed.variants.forEach((v) => {
      const o = document.createElement('option');
      o.value = v.url;
      o.textContent = variantLabel(v);
      o.dataset.group = v.audioGroup || '';
      videoSelect.appendChild(o);
    });
    optionsEl.appendChild(vf.field);

    const af = makeSelectField('Audio');
    audioSelect = af.select;
    audioField = af.field;
    optionsEl.appendChild(af.field);
    videoSelect.addEventListener('change', updateHlsAudio);
    updateHlsAudio();

    go.textContent = 'Download & convert to MP4';
    go.disabled = false;
    go.onclick = () => runHls(videoSelect.value, audioSelect.value || null);
  } else {
    try {
      checkEncryption(parsed);
    } catch (e) {
      showWarn(e.message);
    }
    optionsEl.appendChild(
      makeInfoField(
        'Stream',
        `${parsed.segments.length} segments · ${formatDuration(parsed.totalDuration) || 'unknown length'}${parsed.encrypted ? ' · AES-128' : ''}`,
      ),
    );
    go.textContent = 'Download & convert to MP4';
    go.disabled = false;
    go.onclick = () => runHls(item.url, null);
  }
}

async function runHls(variantUrl, audioUri) {
  startRun();
  try {
    setStatus('Loading media playlist…');
    setProgress(null);
    const vMedia = parseHls(await fetchText(variantUrl), variantUrl);
    if (vMedia.isMaster) throw new Error('Expected a media playlist but got a master.');
    checkEncryption(vMedia);
    if (vMedia.segments.length === 0) throw new Error('No segments in the media playlist.');

    const vSegs = withInit(vMedia.initSegment, vMedia.segments);
    const vExt = hlsExt(vMedia.initSegment, vMedia.segments[0]?.url);
    const vData = await grabTrack(vSegs, 'video');

    let audio = null;
    if (audioUri) {
      setStatus('Loading audio playlist…');
      const aMedia = parseHls(await fetchText(audioUri), audioUri);
      checkEncryption(aMedia);
      const aSegs = withInit(aMedia.initSegment, aMedia.segments);
      const aExt = hlsExt(aMedia.initSegment, aMedia.segments[0]?.url);
      audio = { data: await grabTrack(aSegs, 'audio'), ext: aExt };
    }

    await muxAndSave({ data: vData, ext: vExt }, audio);
  } catch (e) {
    fail(e.message);
  } finally {
    endRun();
  }
}

// ---------------------------------------------------------------------- DASH
function dashVideoLabel(r) {
  const res = r.height ? `${r.height}p` : '';
  const dim = r.width && r.height ? ` (${r.width}×${r.height})` : '';
  const bw = r.bandwidth ? ` · ${Math.round(r.bandwidth / 1000)} kbps` : '';
  const codec = r.codecs ? ` · ${r.codecs}` : '';
  return `${res}${dim}${bw}${codec}`.trim() || `rep ${r.id}`;
}

function dashAudioLabel(r) {
  const lang = r.lang || 'audio';
  const bw = r.bandwidth ? ` · ${Math.round(r.bandwidth / 1000)} kbps` : '';
  const codec = r.codecs ? ` · ${r.codecs}` : '';
  return `${lang}${bw}${codec}`;
}

async function setupDash() {
  setProgressWrap(true);
  setProgress(null);
  setStatus('Loading DASH manifest…');
  let d;
  try {
    d = parseDash(await fetchText(item.url), item.url);
  } catch (e) {
    return fail(`Could not load MPD: ${e.message}`);
  }
  setProgressWrap(false);
  if (d.video.length === 0 && d.audio.length === 0) {
    return fail('No downloadable representations found in the MPD.');
  }
  dashData = d;

  if (d.video.length) {
    const vf = makeSelectField('Video');
    dashVideoSelect = vf.select;
    d.video.forEach((r, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = dashVideoLabel(r);
      dashVideoSelect.appendChild(o);
    });
    optionsEl.appendChild(vf.field);
  }
  if (d.audio.length) {
    const af = makeSelectField('Audio');
    dashAudioSelect = af.select;
    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'None';
    dashAudioSelect.appendChild(none);
    d.audio.forEach((r, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = dashAudioLabel(r);
      dashAudioSelect.appendChild(o);
    });
    dashAudioSelect.selectedIndex = 1; // best audio by default
    optionsEl.appendChild(af.field);
  }

  go.textContent = 'Download & convert to MP4';
  go.disabled = false;
  go.onclick = () => runDash();
}

async function runDash() {
  startRun();
  try {
    const vRep = dashVideoSelect ? dashData.video[Number(dashVideoSelect.value)] : null;
    const aVal = dashAudioSelect ? dashAudioSelect.value : '';
    const aRep = aVal !== '' ? dashData.audio[Number(aVal)] : null;
    if (!vRep && !aRep) throw new Error('Nothing selected to download.');

    let video = null;
    let audio = null;
    if (vRep) {
      const data = await grabTrack(withInitUrls(vRep.init, vRep.segments), 'video');
      video = { data, ext: dashExt(vRep) };
    }
    if (aRep) {
      const data = await grabTrack(withInitUrls(aRep.init, aRep.segments), 'audio');
      audio = { data, ext: dashExt(aRep) };
    }
    if (!video && audio) {
      video = audio;
      audio = null;
    }
    await muxAndSave(video, audio);
  } catch (e) {
    fail(e.message);
  } finally {
    endRun();
  }
}
