// Thin wrapper around ffmpeg.wasm (single-threaded core) for remuxing the
// fetched stream bytes into a clean MP4 — entirely in the browser.
//
// All of the fiddly "load wasm inside a Manifest V3 page" logic lives here so
// the rest of the app doesn't care. The UMD globals come from the <script> tags
// in downloader.html (vendor/ffmpeg/ffmpeg.js), populated by `npm run setup`.

let _ffmpeg = null;
let _loading = null;

/**
 * @param {string} base  chrome.runtime.getURL('vendor/ffmpeg/')
 * @param {(line:string)=>void} [onLog]
 */
export async function loadFFmpeg(base, onLog) {
  if (_ffmpeg) return _ffmpeg;
  if (_loading) return _loading;

  _loading = (async () => {
    const FFmpegWASM = self.FFmpegWASM;
    if (!FFmpegWASM || !FFmpegWASM.FFmpeg) {
      throw new Error(
        'ffmpeg.wasm is not bundled. Run "npm run setup" to download vendor/ffmpeg/ first.',
      );
    }
    const ff = new FFmpegWASM.FFmpeg();
    if (onLog) ff.on('log', ({ message }) => onLog(message));

    // Single-threaded core: no SharedArrayBuffer / cross-origin isolation needed.
    // All URLs are same-origin extension resources, so CSP (script-src 'self')
    // is satisfied and no blob: worker is required.
    await ff.load({
      classWorkerURL: base + 'ffmpeg-worker.js',
      coreURL: base + 'ffmpeg-core.js',
      wasmURL: base + 'ffmpeg-core.wasm',
    });
    _ffmpeg = ff;
    return ff;
  })();

  try {
    return await _loading;
  } finally {
    _loading = null;
  }
}

export function isFFmpegLoaded() {
  return !!_ffmpeg;
}

/**
 * Remux already-concatenated track bytes into MP4.
 * @param {object} args
 * @param {{data:Uint8Array, ext:string}} args.video  required video track
 * @param {{data:Uint8Array, ext:string}} [args.audio] optional separate audio track
 * @param {string} args.base   chrome.runtime.getURL('vendor/ffmpeg/')
 * @param {(line:string)=>void} [args.onLog]
 * @param {(ratio:number)=>void} [args.onProgress]
 * @returns {Promise<Uint8Array>} mp4 bytes
 */
export async function muxToMp4({ video, audio, base, onLog, onProgress }) {
  const ff = await loadFFmpeg(base, onLog);
  if (onProgress) ff.on('progress', ({ progress }) => onProgress(Math.min(1, progress || 0)));

  const vName = `in_v.${video.ext || 'ts'}`;
  await ff.writeFile(vName, video.data);

  const cmd = ['-i', vName];
  let aName = null;
  if (audio && audio.data) {
    aName = `in_a.${audio.ext || 'm4a'}`;
    await ff.writeFile(aName, audio.data);
    cmd.push('-i', aName);
  }

  // Stream-copy (no re-encode) for speed; just repackage into MP4.
  cmd.push('-c', 'copy');
  if (aName) cmd.push('-map', '0:v:0', '-map', '1:a:0');

  // MPEG-TS carries ADTS AAC; converting to MP4 needs this bitstream filter.
  if (video.ext === 'ts' || audio?.ext === 'ts') cmd.push('-bsf:a', 'aac_adtstoasc');

  cmd.push('-movflags', '+faststart', 'out.mp4');

  const code = await ff.exec(cmd);
  if (code !== 0) {
    throw new Error(
      `ffmpeg exited with code ${code}. The stream may use a codec/container that needs re-encoding.`,
    );
  }

  const out = await ff.readFile('out.mp4');
  // Clean up the virtual FS so repeated downloads don't accumulate.
  try {
    await ff.deleteFile(vName);
    if (aName) await ff.deleteFile(aName);
    await ff.deleteFile('out.mp4');
  } catch {
    /* non-fatal */
  }
  return out instanceof Uint8Array ? out : new Uint8Array(out);
}
