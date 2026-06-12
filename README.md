# StreamGrab

A **fully open-source, in-browser video downloader** for Chrome — a clean-room
alternative to Video DownloadHelper with **no closed "companion app."**

It detects media playing on any page (HLS, DASH, or direct files), lets you pick
the quality, downloads every segment, and **muxes it into an MP4 entirely inside
your browser using [ffmpeg.wasm](https://ffmpegwasm.netlify.app/)**. Nothing is
ever uploaded — all processing is local.

> The part of VDH that *isn't* open source is its native ffmpeg "companion app."
> StreamGrab replaces it with ffmpeg compiled to WebAssembly, so the whole thing
> is one MIT-licensed extension you can read end to end.

---

## Features

- 🔎 **Auto-detection** of media via the network — the toolbar badge shows a count.
- 🎞 **HLS** (`.m3u8`): master/variant playlists, quality picker, separate audio
  renditions, fMP4 **and** MPEG-TS segments, byte-ranges, **AES-128 decryption**.
- 🧩 **DASH** (`.mpd`): `SegmentTemplate` (fixed-duration **and** `SegmentTimeline`),
  `SegmentBase` single-file, separate video/audio representation selection.
- 📁 **Direct files** (`.mp4`, `.webm`, `.m4a`, `.mp3`, …): one-click save.
- 🛠 **Local muxing to MP4** with ffmpeg.wasm (stream-copy, no re-encode → fast).
- 🔐 100% local & private. MIT licensed.

## Limitations (by design / TODO)

- ❌ **DRM** (Widevine / FairPlay / PlayReady / HLS `SAMPLE-AES`) — impossible to
  download and intentionally unsupported. StreamGrab will tell you when it sees it.
- The single-threaded ffmpeg core is used (no `SharedArrayBuffer` needed in MV3),
  so very large muxes are slower and bounded by tab memory.
- DASH: first `<Period>` only; `SegmentList` not yet implemented.

Please only download content you have the right to. See **Legal** below.

---

## Install (developer / unpacked)

Requires **Node 18+** (only to fetch ffmpeg.wasm and generate icons — there is no
build step or bundler).

```bash
cd streamgrab
npm run setup      # generates icons/ and downloads vendor/ffmpeg/ (~30 MB)
```

Then load it in Chrome:

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top-right)
3. **Load unpacked** → select the `streamgrab/` folder
4. Pin the StreamGrab icon to your toolbar

> `npm run setup` runs two scripts: `make-icons.mjs` (writes real PNG icons with
> zero dependencies) and `fetch-ffmpeg.mjs` (downloads the ffmpeg.wasm core +
> worker into `vendor/ffmpeg/`). Re-run `npm run ffmpeg` if you ever clear it.

## Usage

1. Open a page and start playing a video.
2. The StreamGrab toolbar icon shows a **badge count** of detected media.
3. Click it → pick an item → **Get**.
4. In the downloader tab, choose quality/audio → **Download & convert to MP4**.
5. Watch the progress bar; when muxing finishes you choose where to save.

---

## Architecture

```
manifest.json                MV3 manifest (webRequest + downloads + storage)
src/
  background/
    detector.js              pure classifier: is this response media? what kind?
    service-worker.js        webRequest sniffer, per-tab catalogue, badge, routing
  popup/                     toolbar popup: lists detected media for the active tab
  downloader/                full-page UI: parse → pick → fetch → mux → save
  lib/
    hls.js                   HLS master/media parser (keys, byte-ranges, fMP4 init)
    dash.js                  DASH MPD parser (SegmentTemplate/Timeline/Base)
    segment-fetcher.js       concurrent fetch (+ retry, byte-range, AES-128)
    decrypt.js               AES-128-CBC via WebCrypto
    ffmpeg-runner.js         ffmpeg.wasm loader + remux to MP4
    util.js                  shared helpers
scripts/
  make-icons.mjs             dependency-free PNG icon generator
  fetch-ffmpeg.mjs           downloads ffmpeg.wasm into vendor/ffmpeg/
vendor/ffmpeg/               (generated) ffmpeg.wasm core + worker
icons/                       (generated) toolbar icons
```

**How a streaming download works**

1. The service worker observes responses (`chrome.webRequest.onResponseStarted`),
   classifies each as `hls` / `dash` / `direct`, and stores it per tab.
2. The popup lists them; **Get** opens the downloader page (which persists and can
   run heavy work — unlike the ephemeral MV3 service worker).
3. The downloader fetches and parses the manifest, you pick a quality, then it
   downloads every segment concurrently (decrypting AES-128 on the fly).
4. Segments (+ init) are concatenated per track and handed to ffmpeg.wasm, which
   stream-copies them into a faststart MP4. The result is saved via
   `chrome.downloads`.

### Why ffmpeg.wasm single-threaded?

The multi-threaded core needs `SharedArrayBuffer`, which needs cross-origin
isolation (COOP+COEP) — awkward to obtain inside an MV3 extension page. The
single-threaded core just loads from same-origin extension URLs, satisfying the
default `script-src 'self'` CSP with no blob workers. Slower, but robust.

## Roadmap

- [ ] DASH `SegmentList` + multi-period
- [ ] Subtitle/caption download (WebVTT) and muxing
- [ ] Optional re-encode presets (H.264/AAC) for stubborn codecs
- [ ] Firefox (MV3) port
- [ ] Resume/retry of partially-failed segment batches

## Legal

StreamGrab is a general-purpose tool. Downloading copyrighted material without
permission, or content protected by DRM or a site's Terms of Service, may be
illegal in your jurisdiction. **You** are responsible for how you use it. The
authors provide it for personal archival, accessibility, and other lawful uses.

## License

MIT — see [LICENSE](LICENSE).
