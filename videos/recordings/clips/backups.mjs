// Clip: off-site backups and a restore test.
//
// The terminal part runs real platformctl commands on the server over SSH
// and streams their output; the age identity for the restore test is piped
// from a file on the recording machine and never shown. Then the portal's
// Settings, Security tab shows the results under "Recovery backups".
//
// Preconditions (README, "Seed data"): an off-site target set with
// `platformctl backup target set`, and `platformctl backup init` done.
//
// Env: CAIRN_URL + sign-in, BACKUP_SSH (user@host, key already loaded in
// ssh-agent), BACKUP_IDENTITY_FILE (age identity.txt), optional
// BACKUP_SKIP_ARCHIVE=1 to use the latest archive instead of taking one.
import { readFile } from 'node:fs/promises';
import { cairnUrl, env } from '../lib/config.mjs';
import { Recording, beat, click, moveTo, response } from '../lib/recorder.mjs';
import { Terminal } from '../lib/terminal.mjs';

// -q: no "Connection to ... closed." line after each command.
const ssh = (host, command) => ['ssh', '-q', '-o', 'BatchMode=yes', '-tt', host, command];

export async function record() {
  const host = env('BACKUP_SSH', { required: true });
  const identity = await readFile(env('BACKUP_IDENTITY_FILE', { required: true }), 'utf8');
  const takeArchive = env('BACKUP_SKIP_ARCHIVE') !== '1';

  const rec = await Recording.open('backups');
  try {
    const page = rec.page();
    const term = await Terminal.open(page, { title: 'On the Cairn server' });
    rec.mark('start');
    await beat(600);

    // 1. Where backups go, and a live check that the bucket works.
    let run = await term.run(ssh(host, 'sudo -n platformctl backup target test'), { shown: 'sudo platformctl backup target test' });
    let result = await run.done;
    if (result.code !== 0 || !result.output.includes('Backup target works')) throw new Error('backup target test failed');
    rec.mark('target-ok');
    await beat(1500);

    // 2. An encrypted archive of everything (cut: it takes minutes).
    if (takeArchive) {
      rec.mark('archive');
      run = await term.run(ssh(host, 'sudo -n platformctl backup --all'), { shown: 'sudo platformctl backup --all' });
      result = await rec.cut('archive', () => run.done);
      if (result.code !== 0) throw new Error('backup --all failed');
      rec.mark('archive-done');
      await beat(1500);
    }

    // 3. Restore the latest archive into a scratch database and check it.
    rec.mark('restore-test');
    // -T: no remote tty, so the identity on stdin reaches platformctl and is never echoed.
    run = await term.run(['ssh', '-q', '-o', 'BatchMode=yes', '-T', host, 'sudo -n platformctl backup restore-test'], {
      shown: "cat identity.txt | ssh server 'sudo platformctl backup restore-test'",
      input: identity,
    });
    result = await rec.cut('restore', () => run.done);
    if (result.code !== 0 || !result.output.includes('Restore test passed')) throw new Error('restore test failed');
    rec.mark('restore-passed');
    await beat(2500);

    // 4. The same results in the portal.
    await rec.navigate('settings', page, `${cairnUrl()}/settings`, () => page.getByRole('button', { name: 'Security', exact: true }).waitFor());
    await click(page, page.getByRole('button', { name: 'Security', exact: true }));
    const panel = page.locator('section[aria-labelledby="st-backups-title"]');
    await panel.waitFor();
    await panel.scrollIntoViewIfNeeded();
    const loaded = response(page, '/api/settings/backups');
    await click(page, panel.getByRole('button', { name: 'Refresh', exact: true }));
    await loaded;
    const latest = panel.locator('li').filter({ hasText: 'Latest restore test' });
    await latest.getByText('Passed', { exact: true }).waitFor({ timeout: 60_000 });
    rec.mark('portal');
    // Point at the result, not the middle of the row (that covers the size).
    await moveTo(page, latest.getByText('Passed', { exact: true }));
    await beat(3000);
    rec.mark('end');
    await rec.close();
  } catch (error) {
    await rec.abort();
    throw error;
  }
}
