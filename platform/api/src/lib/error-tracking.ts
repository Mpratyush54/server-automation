import { randomUUID } from 'crypto';
import { getDb } from '../config/database';
import { ErrorEvent } from './error-event';
import { fingerprint, isNewerRelease } from './error-fingerprint';
import { symbolicate } from './error-sourcemaps';
import { publishAlertEvent } from './alert-events';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateErrorEvent(body: any): ErrorEvent {
  const text = (v: unknown, max: number, required = false): string => {
    if (v == null && !required) return undefined;
    if (typeof v !== 'string' || (required && !v.trim()) || v.length > max) throw new Error('Invalid error event field');
    return v;
  };
  if (!body || !Array.isArray(body.frames) || body.frames.length > 100) throw new Error('Expected at most 100 frames');
  const event: ErrorEvent = {
    eventId: body.eventId || randomUUID(), type: text(body.type, 200, true), message: text(body.message, 8000, true),
    release: text(body.release, 200, true), environment: text(body.environment, 100, true),
    traceId: text(body.traceId, 32), userId: text(body.userId, 200), sessionId: text(body.sessionId, 200), replayId: text(body.replayId, 200),
    frames: body.frames.map((f: any) => {
      if (!Number.isSafeInteger(f.line) || f.line < 1 || f.line > 10000000 || !Number.isSafeInteger(f.column) || f.column < 0 || f.column > 10000000) throw new Error('Invalid frame coordinates');
      return { file: text(f.file, 2048, true), line: f.line, column: f.column, function: text(f.function, 300) };
    }),
  };
  if (!uuid.test(event.eventId) || (event.traceId && !/^[0-9a-f]{32}$/i.test(event.traceId))) throw new Error('Invalid event/trace id');
  if (body.breadcrumbs !== undefined) {
    if (!Array.isArray(body.breadcrumbs) || body.breadcrumbs.length > 100) throw new Error('Expected at most 100 breadcrumbs');
    event.breadcrumbs = body.breadcrumbs.map((b: any) => ({ message: text(b.message, 1000, true), timestamp: text(b.timestamp, 40), category: text(b.category, 100) }));
  }
  return event;
}

export async function processErrorEvent(payload: { projectId: string; event: ErrorEvent }): Promise<void> {
  const { projectId } = payload;
  const event = validateErrorEvent(payload.event);
  const display = await symbolicate(projectId, event);
  const hash = fingerprint(display);
  // Remember both identities: map uploads can improve grouping without splitting
  // an existing raw group. Original frames connect changing bundles across releases.
  const aliases = [...new Set([fingerprint(event), hash])].sort();
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
