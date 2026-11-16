// Marks, cuts, speed-ups and captions for one recorded clip.
//
// While recording, a clip script calls `mark(name)` at real UI states (for
// example when the deployment turns healthy). Long waits are wrapped in
// `cut()` (removed, with a "2 min skipped" label) or `fast()` (kept, played
// faster, with a "4x speed" label) so the edit stays honest about time.
// After the recording, the marks file plus the clip's captions file give:
//   - the segments of the raw video to keep, and at what speed,
//   - where each label goes in the edited video,
//   - WebVTT captions timed against the edited video.
// Everything here is pure, so it is unit-tested without a browser or ffmpeg.

/** Captions files reference marks by name, optionally with an offset: "deployed+1.5". */
export function resolveTime(ref, marks) {
  if (typeof ref === 'number') return ref;
  const match = /^([a-z0-9:-]+?)([+-]\d+(?:\.\d+)?)?$/i.exec(String(ref).trim());
  if (!match) throw new Error(`Bad time reference: ${ref}`);
  const base = marks[match[1]];
  if (base === undefined) throw new Error(`Unknown mark "${match[1]}" (known: ${Object.keys(marks).join(', ')})`);
  return base + (match[2] ? Number(match[2]) : 0);
}

function ranges(marks, kind) {
  return Object.keys(marks)
    .filter((key) => key.endsWith(`:${kind}-start`))
    .map((key) => {
      const name = key.slice(0, -`:${kind}-start`.length);
      const end = marks[`${name}:${kind}-end`];
      if (end === undefined) throw new Error(`${kind === 'cut' ? 'Cut' : 'Speed-up'} "${name}" has no end`);
      return { name, from: marks[key], to: end };
    });
}

/**
 * Segments of the raw recording, in order, from mark `start` to mark `end`:
 * { from, to, speed } pieces to keep and { cut } markers where time was
 * removed. A little of each cut is kept on both sides so the change on
 * screen is visible. `speeds` maps a speed-up name to its factor.
 */
export function keepSegments(marks, { speeds = {}, keepAroundCut = 0.6, replaySkips = [] } = {}) {
  const start = marks.start ?? 0;
  const end = marks.end;
  if (end === undefined || end <= start) throw new Error('A clip needs "start" and "end" marks, in that order');
  const events = [
    ...ranges(marks, 'cut')
      .map((c) => ({ ...c, from: c.from + keepAroundCut, to: c.to - keepAroundCut, kind: 'cut' }))
      .filter((c) => c.to - c.from > 1),
    ...ranges(marks, 'fast').map((f) => ({ ...f, kind: 'fast', speed: speeds[f.name] ?? 4 })),
  ].sort((a, b) => a.from - b.from);
  const segments = [];
  let cursor = start;
  for (const event of events) {
    if (event.from < cursor || event.to > end) throw new Error(`"${event.name}" overlaps another cut or speed-up, or the clip edges`);
    if (event.from > cursor) segments.push({ from: cursor, to: event.from, speed: 1 });
    if (event.kind === 'cut') segments.push({ cut: event });
    else segments.push({ from: event.from, to: event.to, speed: event.speed, name: event.name });
    cursor = event.to;
  }
  if (end > cursor) segments.push({ from: cursor, to: end, speed: 1 });
  // Pauses the terminal replay already shortened: labels only, nothing to remove.
  for (const skip of replaySkips) segments.push({ label: skip });
  return segments.filter((s) => s.cut || s.label || s.to - s.from > 0.05);
}

const played = (s) => (s.to - s.from) / s.speed;

/** Map a time in the raw recording to the edited video (after cuts, speed-ups and an optional title card). */
export function editedTime(rawTime, segments, offset = 0) {
  let edited = offset;
  for (const segment of segments) {
    if (segment.label) continue;
    if (segment.cut) {
      if (rawTime >= segment.cut.from && rawTime < segment.cut.to) return edited; // inside a cut: snap to the join
      continue;
    }
    if (rawTime < segment.from) return edited;
    if (rawTime <= segment.to) return edited + (rawTime - segment.from) / segment.speed;
    edited += played(segment);
  }
  return edited;
}

export function formatSkipped(seconds) {
  const s = Math.round(seconds);
  if (s < 60) return `${s} s skipped`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m} min ${rest} s skipped` : `${m} min skipped`;
}

/** On-screen labels for the edited video: where time was skipped or sped up. */
export function timeLabels(segments, offset = 0) {
  const labels = [];
  let edited = offset;
  for (const segment of segments) {
    if (segment.label) continue;
    if (segment.cut) {
      labels.push({ from: edited, to: edited + 2, text: formatSkipped(segment.cut.to - segment.cut.from) });
    } else {
      if (segment.speed !== 1) labels.push({ from: edited, to: edited + played(segment), text: `${segment.speed}x speed` });
      edited += played(segment);
    }
  }
  for (const segment of segments.filter((s) => s.label)) {
    const at = editedTime(segment.label.at, segments, offset);
    labels.push({ from: at, to: at + 2, text: formatSkipped(segment.label.skipped) });
  }
  return labels.sort((a, b) => a.from - b.from);
}

function vttTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const rest = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(rest).padStart(3, '0')}`;
}

/**
 * WebVTT for the edited clip. `cues` come from captions/<clip>.json:
 * [{ "from": "mark", "to": "mark+2", "text": "..." }]. A cue without `to`
 * lasts until the next cue starts (or the end of the clip). A cue whose
 * start mark the run did not set (an optional step) is left out.
 */
export function buildVtt(cues, marks, segments, { offset = 0, minDuration = 1.2 } = {}) {
  const total = editedTime(marks.end, segments, offset);
  const known = (ref) => typeof ref === 'number' || marks[String(ref).split(/[+-]\d/)[0]] !== undefined;
  const timed = cues
    .filter((cue) => known(cue.from))
    .map((cue) => ({
      text: String(cue.text).trim(),
      from: editedTime(resolveTime(cue.from, marks), segments, offset),
      // An end mark the run did not set: the cue lasts until the next one.
      to: cue.to === undefined || !known(cue.to) ? undefined : editedTime(resolveTime(cue.to, marks), segments, offset),
    }))
    .sort((a, b) => a.from - b.from);
  const lines = ['WEBVTT', ''];
  timed.forEach((cue, index) => {
    if (!cue.text) throw new Error('A caption has no text');
    if (/\p{Extended_Pictographic}/u.test(cue.text)) throw new Error(`No emoji in captions: ${cue.text}`);
    const next = timed[index + 1]?.from ?? total;
    const to = Math.min(cue.to ?? next, next, total);
    if (to - cue.from < minDuration) throw new Error(`Caption "${cue.text}" is on screen for under ${minDuration} s; move its marks`);
    lines.push(String(index + 1), `${vttTime(cue.from)} --> ${vttTime(to)}`, cue.text, '');
  });
  return lines.join('\n');
}
