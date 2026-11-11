import { randomUUID } from 'crypto';
import { getDb } from '../config/database';
import { ErrorEvent } from './error-event';
import { fingerprint, groupingFingerprint, isNewerRelease, parseStack } from './error-fingerprint';
import { symbolicate } from './error-sourcemaps';
import { publishAlertEvent } from './alert-events';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateErrorEvent(body: any): ErrorEvent {
  const text = (name: string, v: unknown, max: number, required = false): string => {
    if (v == null && !required) return undefined;
    if (v == null || (typeof v === 'string' && required && !v.trim())) throw new Error(`Missing error event field: ${name}`);
    if (typeof v !== 'string') throw new Error(`Invalid error event field: ${name} must be a string`);
    if (v.length > max) throw new Error(`Invalid error event field: ${name} exceeds ${max} characters`);
    return v;
  };
  if (!body) throw new Error('Expected at most 100 frames');
  // Browsers that only expose Error.stack may send it instead of parsed frames;
  // V8 and SpiderMonkey/JavaScriptCore formats parse to the same frames (#156).
  if ((body.frames == null || (Array.isArray(body.frames) && !body.frames.length)) && typeof body.stack === 'string') {
    body = { ...body, frames: parseStack(text('stack', body.stack, 65536)) };
  }
  if (!Array.isArray(body.frames) || body.frames.length > 100) throw new Error('Expected at most 100 frames');
  // Every SDK (Node, Python, React/Angular RUM) sends "unknown" when no app
  // version is configured; accept an omitted release the same way.
  const release = body.release == null || (typeof body.release === 'string' && !body.release.trim()) ? 'unknown' : body.release;
  const event: ErrorEvent = {
    eventId: body.eventId || randomUUID(), type: text('type', body.type, 200, true), message: text('message', body.message, 8000, true),
    release: text('release', release, 200, true), environment: text('environment', body.environment, 100, true),
    traceId: text('traceId', body.traceId, 32), userId: text('userId', body.userId, 200), sessionId: text('sessionId', body.sessionId, 200), replayId: text('replayId', body.replayId, 200),
    frames: body.frames.map((f: any, i: number) => {
      if (!Number.isSafeInteger(f.line) || f.line < 1 || f.line > 10000000 || !Number.isSafeInteger(f.column) || f.column < 0 || f.column > 10000000) throw new Error(`Invalid frame coordinates: frames[${i}]`);
      return { file: text(`frames[${i}].file`, f.file, 2048, true), line: f.line, column: f.column, function: text(`frames[${i}].function`, f.function, 300) };
    }),
  };
  if (!uuid.test(event.eventId) || (event.traceId && !/^[0-9a-f]{32}$/i.test(event.traceId))) throw new Error('Invalid event/trace id');
  if (body.breadcrumbs !== undefined) {
    if (!Array.isArray(body.breadcrumbs) || body.breadcrumbs.length > 100) throw new Error('Expected at most 100 breadcrumbs');
    event.breadcrumbs = body.breadcrumbs.map((b: any) => ({ message: text('breadcrumbs.message', b.message, 1000, true), timestamp: text('breadcrumbs.timestamp', b.timestamp, 40), category: text('breadcrumbs.category', b.category, 100) }));
  }
  return event;
}

export async function processErrorEvent(payload: { projectId: string; event: ErrorEvent }): Promise<void> {
  const { projectId } = payload;
  const event = validateErrorEvent(payload.event);
  const display = await symbolicate(projectId, event);
  // Engine/build-neutral key (#156) is the identity of new issues. The legacy raw
  // and mapped keys stay as aliases so issues grouped before #156 keep matching:
  // map uploads can improve grouping without splitting an existing raw group, and
  // original frames connect changing bundles across releases.
  const hash = groupingFingerprint(event, display);
  const aliases = [...new Set([fingerprint(event), fingerprint(display), hash])].sort();
  const db = await getDb();
  const outcome = await db.transaction(async tx => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['error-event', projectId, event.eventId])]);
    for (const alias of aliases) await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify([projectId, event.environment, alias])]);
    if ((await tx.query('SELECT id FROM error_events WHERE project_id=$1 AND id=$2', [projectId, event.eventId])).length) return null;
    const rows = await tx.query(`SELECT * FROM error_issues WHERE project_id=$1 AND environment=$2
      AND (fingerprint=ANY($3::text[]) OR fingerprint_aliases ?| $3::text[])
      ORDER BY first_seen LIMIT 1 FOR UPDATE`, [projectId, event.environment, aliases]);
    let issue = rows[0]; const fresh = !issue;
    if (!issue) {
      [issue] = await tx.query(`INSERT INTO error_issues(project_id,environment,fingerprint,title,latest_release)
        VALUES($1,$2,$3,$4,$5) RETURNING *`, [projectId, event.environment, hash, `${event.type}: ${event.message}`.slice(0, 1000), event.release]);
    }
    const inserted = await tx.query(`INSERT INTO error_events(project_id,id,issue_id,payload) VALUES($1,$2,$3,$4)
      ON CONFLICT(project_id,id) DO NOTHING RETURNING id`, [projectId, event.eventId, issue.id, { ...event, symbolicated: display.frames }]);
    if (!inserted.length) return null;
    const regression = issue.status === 'resolved' && isNewerRelease(event.release, issue.resolved_release || issue.latest_release, issue.release_counts);
    const latest = isNewerRelease(event.release, issue.latest_release, issue.release_counts) ? event.release : issue.latest_release;
    await tx.query(`UPDATE error_issues SET last_seen=now(),count=count+1,
      release_counts=jsonb_set(release_counts,ARRAY[$2]::text[],to_jsonb(COALESCE((release_counts->>$2)::bigint,0)+1)),
      latest_release=$4, status=CASE WHEN $3 THEN 'open' ELSE status END,
      regression=regression OR $3,
      fingerprint_aliases=(SELECT jsonb_agg(DISTINCT value) FROM jsonb_array_elements(fingerprint_aliases || $5::jsonb))
      WHERE id=$1`, [issue.id, event.release, regression, latest, JSON.stringify(aliases)]);
    return fresh || regression ? { id: issue.id, regression, fingerprint: issue.fingerprint || hash } : null;
  });
  if (outcome) await publishAlertEvent({ projectId, environment: event.environment, source: 'error-tracking',
    severity: outcome.regression ? 'critical' : 'warning', dedupeKey: `error:${outcome.fingerprint}:${event.environment}`,
    title: `${outcome.regression ? 'Regression' : 'New issue'}: ${event.type}`, body: event.message,
    url: `/projects/${projectId}/errors?issue=${outcome.id}`, labels: { release: event.release, issueId: outcome.id } });
}
