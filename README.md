# VideoGrabitel

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

<img src="docs/popup.png" width="470" alt="The popup on a YouTube page: main video with live download progress, a detected HLS stream below, engine line in the footer">

*The popup on a YouTube page: the page's main video (thumbnail, title, real
resolutions) downloading with inline progress, a detected HLS stream below it,
and the local yt-dlp + ffmpeg engine in the footer.*

---

## Features

- ▶️ **YouTube** and ~1800 other sites (anything yt-dlp supports) — the page's main
  video is listed first, no extra button.
- 🖼 **Everything in the popup** — thumbnail, title, duration, and live download
  progress, all inline. No extra tab or page.
- 🎞 **HLS / DASH / direct files** detected automatically (deduped) and listed
  alongside the page's main video.
- 🎚 **Quality**: pick from the video's real resolutions, or audio-only (mp3).
  Defaults to H.264 ≤1080p so it plays everywhere.
- ✏️ **Rename before downloading** — edit the title and that becomes the filename.
- 🌐 **Optional proxy** (behind ⚙) — your in-Chrome VPN doesn't reach the helper,
  so point yt-dlp at a proxy when you need one.
- 📂 **Open file / show in folder** when a download finishes.
- 🔁 **Keeps downloading after you close the popup** — the download runs in the
  service worker; reopen the popup to see current progress. Auto-retries on flaky
  connections.
- 💾 **No memory limits** — yt-dlp streams straight to your Downloads folder.
- 🔐 **100% local & private.** Nothing is uploaded. MIT licensed.

## Requirements

- **Google Chrome** (or Edge)
- **Node.js 18+** on your PATH (the helper runs on Node)
- Windows is fully automated below; macOS/Linux notes are inline.

## Install

```bash
cd videograbitel
npm run setup          # generate icons + download yt-dlp, ffmpeg & deno into bin/
```

1. **Load the extension:** `chrome://extensions` → enable **Developer mode** →
   **Load unpacked** → select the `videograbitel/` folder.
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

1. Open any page with a video and click the **VideoGrabitel** toolbar icon.
2. The popup lists the page's **main video first** (with thumbnail, title and the
   resolutions it actually offers), then any detected HLS/DASH/direct streams.
3. Optionally **✎ rename** it (the name becomes the filename) and pick a **quality**.
4. Hit **⬇ Download** — progress shows inline in the same card. It keeps running even
   if you close the popup; reopen to check on it, then **Open** / **Show in folder**
   when it's done. Files land in your **Downloads** folder.

Behind **⚙** there's an optional **proxy** (with an on/off toggle): the helper runs
outside Chrome, so an in-browser VPN doesn't apply to it — set a proxy yt-dlp can use
(`socks5://…` or `http://…`) if you need to reach geo-blocked content.

---

## Architecture

```
manifest.json                MV3 manifest (pinned key + nativeMessaging perm)
src/
  background/
    service-worker.js        webRequest sniffer → per-tab catalogue + badge
    detector.js              classifies media responses
    queue.js                 download queue (owns the native Ports; in-memory)
    queue-core.js            pure queue helpers (unit-tested)
  popup/                     the whole UI: video cards, preview, rename, quality,
                             inline progress, and the ⚙ proxy setting
  lib/util.js                shared helpers
  native-host/host.js        Node native-messaging host: spawns yt-dlp, streams progress
videograbitel-host.exe          (generated) Windows no-console launcher (from scripts/launcher.cs)
videograbitel-host.bat          Windows fallback launcher (used if csc.exe is unavailable)
videograbitel-host.sh           macOS/Linux launcher
scripts/
  make-icons.mjs             dependency-free PNG icons
  fetch-tools.mjs            downloads yt-dlp + ffmpeg + deno into bin/ (Windows auto)
  install-host.mjs           compiles the launcher + registers the native host (all OSes)
  launcher.cs                GUI-subsystem launcher source (compiled at install on Windows)
  gen-key.mjs                regenerates the pinned key + extension id
test/                        unit tests for the detector, queue + helpers (npm test)
bin/                         (generated) yt-dlp + ffmpeg + deno
icons/                       (generated) toolbar icons
```

**Flow:** the popup previews the page's video and lists detected streams → on
**Download** it queues a job in the **service worker**, which opens a
`chrome.runtime.connectNative` Port to `com.videograbitel.host` (one host process per
download) → the host runs `yt-dlp` with the chosen quality / filename / proxy, writing
to your Downloads folder → progress streams back over the Port and the popup renders it
live (and re-syncs via `queue:list` whenever it reopens). Because the **worker** (not
the popup) owns the Port, closing the popup never stops a download. File bytes never
pass through the browser.

**Native-messaging protocol** (4-byte LE length + JSON):
`{action:'ping'}` → `{type:'pong', ytdlp, ffmpeg, deno}` ·
`{action:'preview', url, proxy}` → `{type:'preview', title, thumbnail, duration, heights, …}` ·
`{action:'download', url, quality, subs, filename, proxy}` → `started` / `progress` / `phase` / `log` / `done` / `cancelled` / `error` ·
`{action:'cancel'}` · `{action:'reveal'|'open', file}`.

## Limitations & distribution

- ❌ **DRM** (Widevine / FairPlay) — still impossible, by design.
- The helper requires a **one-time install** (it runs the local yt-dlp/ffmpeg tools).
- On Windows the host launches via a compiled no-console helper
  (`videograbitel-host.exe`, built at install time from `scripts/launcher.cs` with
  the in-box C# compiler), so **no console window appears**. If that compiler isn't
  available it falls back to a `.bat`, which can briefly flash a console.
- The Chrome Web Store can distribute the *extension* but **not** the native host,
  so a separate one-time host install is always required — this is inherent to
  native messaging, not specific to VideoGrabitel.

## License

MIT — see [LICENSE](LICENSE).
