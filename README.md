# StreamGrabitel

A **fully open-source video downloader** for Chrome, with **nothing
closed-source**.

A lightweight **in-browser detector** spots media on any page, and a small
**local helper** (a native-messaging host running **yt-dlp + ffmpeg**) does the
actual downloading. That combination handles **YouTube**, HLS, DASH and direct
files, with no browser memory limits.

> **How it works:** the browser half just detects media and drives the UI; all
> downloading and muxing is done by **yt-dlp + ffmpeg** running locally. Both are
> open source, so the whole pipeline is auditable end to end. For YouTube this is
> as reliable as yt-dlp itself, which tracks YouTube's changes closely.

---

## Features

- ▶️ **YouTube** and ~1800 other sites (anything yt-dlp supports) — via the
  "Download this page's video" button.
- 🖼 **Preview before downloading** — thumbnail, title, duration, and the
  resolutions the video actually offers.
- 🎞 **HLS / DASH / direct files** detected automatically (deduped); the toolbar
  badge shows a count.
- 🎚 **Quality**: pick from the video's real resolutions, or audio-only (mp3).
  Defaults to H.264 ≤1080p so it plays everywhere.
- 💬 **Optional subtitle embedding** (English).
- 📂 **Open file / show in folder** when a download finishes.
- 🔁 **Resumable**, with automatic retries on flaky connections.
- 💾 **No memory limits** — yt-dlp streams straight to your Downloads folder.
- 🔐 **100% local & private.** Nothing is uploaded. MIT licensed.

## Requirements

- **Google Chrome** (or Edge)
- **Node.js 18+** on your PATH (the helper runs on Node)
- Windows is fully automated below; macOS/Linux notes are inline.

## Install

```bash
cd streamgrabitel
npm run setup          # generate icons + download yt-dlp, ffmpeg & deno into bin/
```

1. **Load the extension:** `chrome://extensions` → enable **Developer mode** →
   **Load unpacked** → select the `streamgrabitel/` folder.
   (The extension ID is pinned to `eogbccakibimjjinpjpbenjnmfgobegc` via the
   manifest `key`, so the helper can whitelist it.)
2. **Register the helper:**
   ```bash
   npm run install-host
   ```
   This registers the native-messaging host for Chrome/Edge (and Chromium).
3. **Reload the extension** (↻ on its card) so it picks up the host.
4. Open the popup — the footer should read **`engine: yt-dlp <version> + ffmpeg + deno`**.

> Moved the folder after installing? Re-run `npm run install-host` (it records an
> absolute path). Uninstall any time with `npm run uninstall-host`.

### macOS / Linux

`npm run install-host` works on all three platforms (registry on Windows; a
manifest dropped into each browser's `NativeMessagingHosts` directory on
macOS/Linux). `npm run fetch-tools` only auto-downloads the binaries on Windows —
elsewhere install them with your package manager (`brew install yt-dlp ffmpeg deno`,
etc.); the host finds them on PATH.

## Usage

1. Open any page with a video.
2. Click the **StreamGrabitel** toolbar icon.
3. Pick a **quality**, then either:
   - **⬇ Download this page's video** — grabs the page's main video (YouTube etc.), or
   - **Get** on any auto-detected HLS/DASH/direct item.
4. A tab opens showing live progress; the file lands in your **Downloads** folder.

---

## Architecture

```
manifest.json                MV3 manifest (pinned key + nativeMessaging perm)
src/
  background/                webRequest sniffer → per-tab catalogue + badge
  popup/                     quality picker, "download page", detected list, engine status
  downloader/                progress UI; drives the native host over a Port
  lib/util.js                shared helpers
  native-host/host.js        Node native-messaging host: spawns yt-dlp, streams progress
streamgrabitel-host.bat          Windows launcher Chrome invokes (runs host.js on Node)
streamgrabitel-host.sh           macOS/Linux launcher
scripts/
  make-icons.mjs             dependency-free PNG icons
  fetch-tools.mjs            downloads yt-dlp + ffmpeg + deno into bin/ (Windows auto)
  install-host.mjs           registers/unregisters the native host (all OSes)
  gen-key.mjs                regenerates the pinned key + extension id
test/                        unit tests for the detector + helpers (npm test)
bin/                         (generated) yt-dlp + ffmpeg + deno
icons/                       (generated) toolbar icons
```

**Flow:** extension detects media (or you click "download page") → the downloader
page opens a `chrome.runtime.connectNative` Port to `com.streamgrabitel.host` → the
host runs `yt-dlp` with the chosen quality, writing to `~/Downloads` → progress
lines stream back over the Port and render as a bar. File bytes never pass through
the browser.

**Native-messaging protocol** (4-byte LE length + JSON):
`{action:'ping'}` → `{type:'pong', ytdlp, ffmpeg, deno}` ·
`{action:'preview', url}` → `{type:'preview', title, thumbnail, duration, heights, …}` ·
`{action:'download', url, quality, subs}` → `started` / `progress` / `phase` / `log` / `done` / `cancelled` / `error` ·
`{action:'cancel'}` · `{action:'reveal'|'open', file}`.

## Limitations & distribution

- ❌ **DRM** (Widevine / FairPlay) — still impossible, by design.
- The helper requires a **one-time install** (it runs the local yt-dlp/ffmpeg tools).
- On Windows the host launches via a `.bat`, so a console window may briefly flash
  on each download (cosmetic).
- The Chrome Web Store can distribute the *extension* but **not** the native host,
  so a separate one-time host install is always required — this is inherent to
  native messaging, not specific to StreamGrabitel.

## License

MIT — see [LICENSE](LICENSE).
