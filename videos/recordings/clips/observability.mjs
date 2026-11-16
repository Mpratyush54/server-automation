// Clip: logs, metrics and traces for an app.
//
// Uses the project page's Monitoring section (pages/project-detail and
// pages/observability): the overview charts, a log search, the trace behind
// one log line, and back to that request's logs. Needs the full install
// profile and an app instrumented with the Cairn SDK that has served real
// traffic in the last 15 minutes (see README, "Seed data").
//
// Env: CAIRN_URL + sign-in, OBS_PROJECT_ID, OBS_LOG_TEXT (text that appears
// in recent log lines that carry a trace ID, e.g. "GET /api/orders").
import { cairnUrl, env } from '../lib/config.mjs';
import { Recording, beat, click, response, type } from '../lib/recorder.mjs';

export async function record() {
  const projectId = env('OBS_PROJECT_ID', { required: true });
  const logText = env('OBS_LOG_TEXT', { required: true });

  const rec = await Recording.open('observability');
  try {
    const page = rec.page();
    const summary = response(page, /\/observability\/.*(summary|red)/);
    await page.goto(`${cairnUrl()}/projects/${encodeURIComponent(projectId)}?tab=monitoring&view=overview`);
    await summary;
    // Wait for a drawn chart, not just the request.
    await page.getByRole('img', { name: 'Requests per second', exact: true }).waitFor({ timeout: 60_000 });
    rec.mark('start');
    await beat(2500);
    rec.mark('overview-read');

    // Logs: search for a real request.
    const views = page.getByRole('navigation', { name: 'Monitoring views' });
    await click(page, views.getByRole('button', { name: 'Logs', exact: true }));
    const logs = page.locator('app-obs-logs');
    await logs.waitFor();
    rec.mark('logs');
    await type(page, logs.getByLabel('Contains'), logText);
    const queried = response(page, /\/query\/loki/);
    await click(page, logs.getByRole('button', { name: 'Run query', exact: true }));
    await queried;
    const lines = logs.getByRole('log', { name: 'Log lines' });
    await lines.getByText(logText).first().waitFor({ timeout: 60_000 });
    rec.mark('logs-found');
    await beat(1500);

    // The trace behind one of those lines.
    const traceButton = lines.getByRole('button', { name: 'Trace', exact: true }).first();
    const traced = response(page, /\/traces\//);
    await click(page, traceButton);
    await traced;
    const waterfall = page.getByRole('list', { name: 'Trace waterfall', exact: true });
    await waterfall.getByRole('listitem').first().waitFor({ timeout: 60_000 });
    rec.mark('trace');
    await beat(1800);
    const spans = waterfall.getByRole('listitem');
    await click(page, (await spans.count()) > 1 ? spans.nth(1) : spans.first());
    await page.locator('app-obs-trace-view .detail').waitFor();
    rec.mark('span');
    await beat(1800);

    // Back to the log lines of that one request.
    const traceLogs = response(page, /\/query\/loki/);
    await click(page, page.getByRole('button', { name: 'Logs for this trace', exact: true }));
    await traceLogs;
    await page.locator('app-obs-logs').getByRole('log', { name: 'Log lines' }).locator('*').first().waitFor();
    rec.mark('trace-logs');
    await beat(2500);
    rec.mark('end');
    await rec.close();
  } catch (error) {
    await rec.abort();
    throw error;
  }
}
