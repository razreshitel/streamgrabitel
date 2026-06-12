// Minimal DASH (MPD) parser. Supports the common shapes:
//  - SegmentTemplate with $Number$ (fixed duration)
//  - SegmentTemplate with SegmentTimeline ($Time$ / $Number$)
//  - SegmentBase single-file representations (fetched whole)
// First Period only. DRM (ContentProtection) is out of scope.
//
// Runs in a DOM context (downloader page) — uses DOMParser.

import { absolutize } from './util.js';

function parseISODuration(s) {
  if (!s) return 0;
  const m = s.match(/P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);
  if (!m) return 0;
  const [, , , d, h, min, sec] = m.map((x) => (x ? Number(x) : 0));
  return d * 86400 + h * 3600 + min * 60 + sec;
}

/** Effective base URL: fold any <BaseURL> child onto the inherited base. */
function baseFor(el, inherited) {
  const b = [...el.children].find((c) => c.tagName === 'BaseURL');
  return b && b.textContent.trim() ? absolutize(b.textContent.trim(), inherited) : inherited;
}

function fillTemplate(tpl, vars) {
  return tpl.replace(/\$(\$|RepresentationID|Bandwidth|Number|Time)(%0\d+d)?\$/g, (_, name, fmt) => {
    if (name === '$') return '$';
    let val = vars[name];
    if (val === undefined) return '';
    if (fmt) {
      const width = Number(fmt.match(/%0(\d+)d/)[1]);
      val = String(val).padStart(width, '0');
    }
    return String(val);
  });
}

function getSegmentTemplate(rep, adapt) {
  return (
    rep.querySelector(':scope > SegmentTemplate') ||
    adapt.querySelector(':scope > SegmentTemplate') ||
    null
  );
}

function buildFromTemplate(tpl, rep, base, periodDuration) {
  const media = tpl.getAttribute('media');
  const initTpl = tpl.getAttribute('initialization');
  const timescale = Number(tpl.getAttribute('timescale') || 1);
  const startNumber = Number(tpl.getAttribute('startNumber') || 1);
  const vars = {
    RepresentationID: rep.getAttribute('id') || '',
    Bandwidth: rep.getAttribute('bandwidth') || '',
  };

  const init = initTpl ? absolutize(fillTemplate(initTpl, vars), base) : null;
  const segments = [];
  const timeline = tpl.querySelector(':scope > SegmentTimeline');

  if (timeline) {
    let number = startNumber;
    let time = 0;
    let first = true;
    for (const s of timeline.querySelectorAll(':scope > S')) {
      const t = s.getAttribute('t');
      const d = Number(s.getAttribute('d'));
      const r = Number(s.getAttribute('r') || 0); // repeat count
      if (t !== null && first) time = Number(t);
      first = false;
      for (let k = 0; k <= r; k++) {
        segments.push(absolutize(fillTemplate(media, { ...vars, Number: number, Time: time }), base));
        time += d;
        number++;
      }
    }
  } else {
    const segDur = Number(tpl.getAttribute('duration') || 0);
    if (!segDur || !periodDuration) {
      throw new Error('DASH SegmentTemplate without duration/timeline is unsupported.');
    }
    const count = Math.ceil(periodDuration / (segDur / timescale));
    for (let n = 0; n < count; n++) {
      const number = startNumber + n;
      const time = n * segDur;
      segments.push(absolutize(fillTemplate(media, { ...vars, Number: number, Time: time }), base));
    }
  }

  return { init, segments };
}

function repInfo(rep, adapt, base, periodDuration, type) {
  const mimeType = rep.getAttribute('mimeType') || adapt.getAttribute('mimeType') || '';
  const info = {
    id: rep.getAttribute('id') || '',
    type,
    bandwidth: Number(rep.getAttribute('bandwidth') || 0),
    width: Number(rep.getAttribute('width') || adapt.getAttribute('width') || 0),
    height: Number(rep.getAttribute('height') || adapt.getAttribute('height') || 0),
    codecs: rep.getAttribute('codecs') || adapt.getAttribute('codecs') || '',
    mimeType,
    lang: adapt.getAttribute('lang') || '',
    init: null,
    segments: [],
    single: false,
  };

  const tpl = getSegmentTemplate(rep, adapt);
  if (tpl) {
    const built = buildFromTemplate(tpl, rep, base, periodDuration);
    info.init = built.init;
    info.segments = built.segments;
  } else {
    // SegmentBase / plain BaseURL: a single self-contained file.
    const repBase = baseFor(rep, base);
    info.segments = [repBase];
    info.single = true;
  }
  return info;
}

export function parseDash(text, baseUrl) {
  if (typeof DOMParser === 'undefined') throw new Error('DASH parsing requires a DOM context.');
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Invalid MPD (XML parse error).');

  const mpd = doc.querySelector('MPD');
  if (!mpd) throw new Error('No <MPD> root element.');
  const duration = parseISODuration(mpd.getAttribute('mediaPresentationDuration'));

  const mpdBase = baseFor(mpd, baseUrl);
  const period = mpd.querySelector('Period');
  if (!period) throw new Error('No <Period> in MPD.');
  const periodDuration = parseISODuration(period.getAttribute('duration')) || duration;
  const periodBase = baseFor(period, mpdBase);

  const video = [];
  const audio = [];

  for (const adapt of period.querySelectorAll(':scope > AdaptationSet')) {
    const ctype =
      adapt.getAttribute('contentType') ||
      (adapt.getAttribute('mimeType') || '').split('/')[0];
    const adaptBase = baseFor(adapt, periodBase);

    for (const rep of adapt.querySelectorAll(':scope > Representation')) {
      const repBase = baseFor(rep, adaptBase);
      const type = ctype === 'audio' ? 'audio' : ctype === 'video' ? 'video' : null;
      if (!type) continue;
      try {
        const info = repInfo(rep, adapt, repBase, periodDuration, type);
        (type === 'video' ? video : audio).push(info);
      } catch (e) {
        // skip representations we can't model, keep the rest
        console.warn('Skipping DASH representation:', e.message);
      }
    }
  }

  video.sort((a, b) => b.bandwidth - a.bandwidth || b.height - a.height);
  audio.sort((a, b) => b.bandwidth - a.bandwidth);
  return { duration: periodDuration, video, audio };
}
