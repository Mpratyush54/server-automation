// asciicast v2 (asciinema) helpers for the terminal clips.
//
// The install is recorded on the server with `asciinema rec`, which keeps the
// real timing of every line. Before it is replayed for the video:
//   - secrets are masked (the installer prints the admin password, and
//     recordings must never show tokens or keys),
//   - pauses longer than `maxIdle` are shortened, and every shortened pause is
//     reported so the edit can label it ("4 min 10 s skipped").
// Pure functions: unit-tested without a terminal.

export function parseCast(text) {
  const lines = text.split('\n').filter((line) => line.trim());
  if (!lines.length) throw new Error('Empty cast file');
  const header = JSON.parse(lines[0]);
  if (header.version !== 2) throw new Error(`Only asciicast v2 is supported (got ${header.version})`);
  const events = lines.slice(1).map((line) => {
    const [time, type, data] = JSON.parse(line);
    return { time, type, data };
  });
  return { header, events };
}

export function serializeCast({ header, events }) {
  return [JSON.stringify(header), ...events.map((e) => JSON.stringify([Number(e.time.toFixed(6)), e.type, e.data]))].join('\n') + '\n';
}

const MASK = '••••••••';

/**
 * Mask secrets in output events. `secrets` are exact values (from the
 * environment of the recording run); `patterns` catch labelled values such as
 * "Password: xyz" or plat_ tokens even when the exact value is unknown.
 * A secret split across two output chunks is caught by joining neighbours.
 */
export function redactCast(cast, { secrets = [], patterns = DEFAULT_PATTERNS } = {}) {
  const values = secrets.filter((s) => s && s.length >= 4).sort((a, b) => b.length - a.length);
  const scrub = (text) => {
    let out = text;
    for (const value of values) out = out.split(value).join(MASK);
    for (const pattern of patterns) out = out.replace(pattern, (match, label) => (label ? `${label}${MASK}` : MASK));
    return out;
  };
  const events = cast.events.map((event) => ({ ...event }));
  for (let i = 0; i < events.length; i++) {
    if (events[i].type !== 'o') continue;
    events[i].data = scrub(events[i].data);
    // A value cut in half by a chunk boundary: scrub the pair, keep the split point.
    const next = events[i + 1];
    if (next?.type === 'o') {
      const joined = scrub(events[i].data + next.data);
      if (joined !== events[i].data + scrub(next.data)) {
        events[i].data = joined;
        next.data = '';
      }
    }
  }
  return { header: cast.header, events: events.filter((e) => e.type !== 'o' || e.data !== '') };
}

export const DEFAULT_PATTERNS = [
  /((?:password|passwd|secret|token|access key|secret key)\s*[:=]\s*)\S+/gi,
  /plat_(?:agent_)?[A-Za-z0-9_-]{12,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /AGE-SECRET-KEY-1[0-9A-Z]+/g,
];

/**
 * Shorten pauses longer than `maxIdle` seconds to `maxIdle`. Returns the new
 * cast and the list of shortened pauses ({ at, skipped }) in the new timing,
 * so captions and "skipped" labels line up with the replay.
 */
export function capIdle(cast, maxIdle = 2) {
  let shift = 0;
  let previous = 0;
  const skips = [];
  const events = cast.events.map((event) => {
    const gap = event.time - previous;
    previous = event.time;
    if (gap > maxIdle) {
      shift += gap - maxIdle;
      skips.push({ at: event.time - shift, skipped: gap - maxIdle });
    }
    return { ...event, time: event.time - shift };
  });
  return { cast: { header: cast.header, events }, skips };
}

/**
 * Times (in the replay) of the first output that contains each marker text.
 * Clip scripts turn these into marks: e.g. the "Platform provisioned
 * successfully" line becomes the "done" mark.
 */
export function findMarkers(cast, markers) {
  const found = {};
  let screen = '';
  for (const event of cast.events) {
    if (event.type !== 'o') continue;
    screen = (screen + event.data).slice(-4000);
    for (const [name, text] of Object.entries(markers)) {
      if (found[name] === undefined && screen.includes(text)) found[name] = event.time;
    }
  }
  return found;
}
