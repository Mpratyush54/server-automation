// Clip: install with one command.
//
// The install itself is recorded on the fresh server with asciinema, which
// keeps the real timing of every line:
//
//   asciinema rec --idle-time-limit 0 --cols 110 --rows 32 \
//     --command 'sudo -E platformctl provision --auto --profile full' install.cast
//
// This script masks secrets in the cast (the installer prints the admin
// password), shortens pauses longer than INSTALL_MAX_IDLE seconds, replays it
// in a terminal pane at 1280x800 and records that. Every shortened pause
// becomes a labelled cut. It ends on the portal's real sign-in page.
//
// Env: INSTALL_CAST (path), CAIRN_URL, optional INSTALL_MAX_IDLE (default 2),
// INSTALL_SPEED (default 3: banner to done plays this much faster, labelled),
// REDACT_VALUES (newline-separated exact values to mask, e.g. the admin password).
import { readFile } from 'node:fs/promises';
import { cairnUrl, env } from '../lib/config.mjs';
import { capIdle, findMarkers, parseCast, redactCast } from '../lib/cast.mjs';
import { Recording, beat } from '../lib/recorder.mjs';
import { Terminal } from '../lib/terminal.mjs';

export const MARKERS = {
  banner: 'Platform Server Bootstrap',
  preflight: 'Pre-flight Checks',
  components: 'Installing cluster components',
  done: 'Platform provisioned successfully',
};

export async function prepareCast(text, { maxIdle = 2, secrets = [] } = {}) {
  const redacted = redactCast(parseCast(text), { secrets });
  const { cast, skips } = capIdle(redacted, maxIdle);
  const markers = findMarkers(cast, MARKERS);
  for (const name of Object.keys(MARKERS)) {
    if (markers[name] === undefined) throw new Error(`The cast never prints "${MARKERS[name]}". Was the install complete?`);
  }
  return { cast, skips, markers };
}

export async function record() {
  const castFile = env('INSTALL_CAST', { required: true });
  const secrets = (env('REDACT_VALUES', { fallback: '' })).split('\n').map((s) => s.trim()).filter(Boolean);
  const { cast, skips, markers } = await prepareCast(await readFile(castFile, 'utf8'), {
    maxIdle: Number(env('INSTALL_MAX_IDLE', { fallback: '2' })),
    secrets,
  });
  const loginUrl = `${cairnUrl()}/login`;

  const rec = await Recording.open('install', [{ name: 'main', signedIn: false }]);
  try {
    const page = rec.page();
    const term = await Terminal.open(page, { title: 'A fresh Ubuntu server', cols: cast.header.width, rows: cast.header.height });
    rec.mark('start');
    await beat(700);
    await term.typeCommand('sudo platformctl provision --auto --profile full');
    const replayStart = rec.now();
    const seen = new Set();
    // Even with long pauses shortened, a full install prints for over a
    // minute. The edit plays banner..done at INSTALL_SPEED (labelled).
    const speed = Number(env('INSTALL_SPEED', { fallback: '3' }));
    await term.replay(cast, {
      onTime: (t) => {
        for (const [name, at] of Object.entries(markers)) {
          if (!seen.has(name) && t >= at) {
            seen.add(name);
            if (name === 'done' && speed > 1) rec.mark('replay:fast-end');
            rec.mark(name);
            if (name === 'banner' && speed > 1) rec.mark('replay:fast-start');
          }
        }
      },
    });
    if (speed > 1) rec.speeds.replay = speed;
    await beat(2500);
    // Shortened pauses, in raw-video time, so the edit labels them.
    const shortened = skips.map((s) => ({ at: Number((replayStart + s.at).toFixed(3)), skipped: Number(s.skipped.toFixed(1)) }));
    // The real sign-in page at the address the installer printed.
    await rec.navigate('signin', page, loginUrl, () => page.getByLabel('Email or username').waitFor({ state: 'visible' }));
    rec.mark('portal');
    await beat(3000);
    rec.mark('end');
    await rec.close({ replaySkips: shortened });
  } catch (error) {
    await rec.abort();
    throw error;
  }
}
