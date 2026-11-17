// Clip: power off a server; the app keeps answering.
//
// Two panes recorded side by side and joined by post/process.mjs:
//   left  (860x800)  the portal's Infrastructure page, Servers tab;
//   right (420x800)  a real curl loop against the app, run on the recording
//                    machine (outside the cluster), one line per request.
// The power-off is a real command (a cloud API force-stop, or `poweroff`
// over SSH) run by this script; a comment line in the terminal says when.
//
// Preconditions: a 3-server `ha` install (docs/operations/ha.md), the app
// deployed with at least 2 replicas spread over the servers, and its address
// reaching whichever server is up (VIP or load balancer).
//
// Env: CAIRN_URL + sign-in, APP_URL (the app's address), HA_NODE (name of the
// server to power off, as the Servers table shows it), HA_POWEROFF_CMD (shell
// command), optional HA_POWERON_CMD (shell command to bring it back; the clip
// then shows it rejoining).
import { spawn } from 'node:child_process';
import { cairnUrl, env } from '../lib/config.mjs';
import { Recording, beat, click, moveTo } from '../lib/recorder.mjs';
import { Terminal } from '../lib/terminal.mjs';

/** The request loop shown on screen: time, HTTP status, seconds. */
export function curlLoop(url) {
  const quoted = `'${url.replace(/'/g, `'\\''`)}'`;
  return `while true; do printf '%s  ' "$(date +%H:%M:%S)"; curl -s -o /dev/null --max-time 2 -w '%{http_code}  %{time_total}s\\n' ${quoted} || echo 'no answer'; sleep 0.5; done`;
}

function shell(command) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', command], { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`"${command}" exited with ${code}`))));
  });
}

export async function record() {
  const appUrl = env('APP_URL', { required: true });
  const node = env('HA_NODE', { required: true });
  const powerOff = env('HA_POWEROFF_CMD', { required: true });
  const powerOn = env('HA_POWERON_CMD');

  const rec = await Recording.open('high-availability', [
    { name: 'main', viewport: { width: 860, height: 800 }, signedIn: true },
    { name: 'term', viewport: { width: 420, height: 800 }, signedIn: false },
  ]);
  let loop;
  try {
    const page = rec.page('main');
    await page.goto(`${cairnUrl()}/infrastructure`);
    await click(page, page.getByRole('button', { name: 'Servers', exact: true }));
    const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: node, exact: true }) });
    const status = row.locator('.status');
    await status.getByText('Ready', { exact: true }).waitFor({ timeout: 60_000 });
    const readyRows = page.locator('tbody tr').filter({ has: page.locator('.status', { hasText: /^Ready$/ }) });
    if ((await readyRows.count()) < 3) throw new Error('Expected three Ready servers before the test');

    const term = await Terminal.open(rec.page('term'), { title: 'Requests to the app, from outside', fontSize: 13 });
    rec.mark('start');
    loop = await term.run(['bash', '-c', curlLoop(appUrl)], { shown: `curl ${new URL(appUrl).host} every 0.5 s` });
    await beat(6000);
    await moveTo(page, row);

    // Power off one server.
    rec.mark('poweroff');
    await term.write(`\x1b[38;2;242;181;58m# ${new Date().toTimeString().slice(0, 8)} powering off ${node}\x1b[0m\r\n`);
    await shell(powerOff);

    // Kubernetes marks it NotReady after about 40 s; the page polls every 8 s.
    // Sped up, not cut: every request made meanwhile stays on screen.
    await rec.fast('detect', 4, () => status.getByText('NotReady', { exact: true }).waitFor({ timeout: 300_000 }));
    rec.mark('notready');
    await beat(8000);

    if (powerOn) {
      rec.mark('poweron');
      await term.write(`\x1b[38;2;242;181;58m# ${new Date().toTimeString().slice(0, 8)} powering ${node} back on\x1b[0m\r\n`);
      await beat(1500);
      // A cloud start can wait minutes for the forced stop to finish: cut it with the rejoin.
      await rec.cut('rejoin', async () => {
        await shell(powerOn);
        await status.getByText('Ready', { exact: true }).waitFor({ timeout: 900_000 });
      });
      rec.mark('rejoined');
      await beat(4000);
    }
    rec.mark('end');
    await loop.finish();
    // Keep the raw request log next to the video: it is the evidence for the captions.
    await rec.close({ requests: loop.output().split('\n').filter(Boolean) });
  } catch (error) {
    await loop?.finish().catch(() => {});
    await rec.abort();
    throw error;
  }
}
