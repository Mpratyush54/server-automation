import { createHash } from 'crypto';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { getDb } from '../config/database';
import { getUploadStore } from './upload-store';
import { errorFile } from './error-fingerprint';
import { ErrorEvent, ErrorFrame } from './error-event';

// Locked at 0.6.1. Docker copies this pure-JS package from the build tree.
const { SourceMapConsumer } = require('source-map');
const cache = new Map<string, any>();
const MAX_MAP_BYTES = 5 * 1024 * 1024;

export function parseSourceMap(raw: unknown): any {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  if (!text || Buffer.byteLength(text) > MAX_MAP_BYTES) throw new Error('Source map exceeds 5 MiB');
  const map = JSON.parse(text);
  // Indexed maps (including remote URLs) are deliberately unsupported: no remote fetching.
  if (map.version !== 3 || !Array.isArray(map.sources) || map.sections || typeof map.mappings !== 'string') {
    throw new Error('Expected a flat version 3 source map');
  }
  if (map.sources.length > 50000 || map.sources.some((s: unknown) => typeof s !== 'string')) throw new Error('Invalid sources');
  const c = new SourceMapConsumer(map);
  c.eachMapping(() => {}); // force VLQ validation before storing
  return map;
}

export async function uploadSourceMap(projectId: string, release: string, file: string, raw: unknown): Promise<void> {
  const map = parseSourceMap(raw);
  const text = JSON.stringify(map);
  const digest = createHash('sha256').update(text).digest('hex');
  // Content-addressed immutable objects; cross-replica caches cannot become stale.
  const identity = createHash('sha256').update(JSON.stringify([projectId, release, errorFile(file), digest])).digest('hex');
  const key = `error-sourcemaps/${identity}`;
  const store = getUploadStore();
  if (process.env.NODE_ENV === 'production' && store.kind !== 's3') throw new Error('Source maps require MinIO/S3 in production');
  const dir = await mkdtemp(path.join(tmpdir(), 'platform-map-'));
  try {
    const temp = path.join(dir, 'map');
    await writeFile(temp, text);
    await store.put(key, temp, 'application/json');
    await (await getDb()).query(`INSERT INTO error_sourcemaps(project_id,release,file,object_key,digest)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT(project_id,release,file)
      DO UPDATE SET object_key=EXCLUDED.object_key,digest=EXCLUDED.digest`, [projectId, release, errorFile(file), key, digest]);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export function mapFrame(frame: ErrorFrame, consumer: any): ErrorFrame {
  const pos = consumer.originalPositionFor({ line: frame.line, column: frame.column });
  return pos.source && pos.line != null ? { file: pos.source, line: pos.line, column: pos.column ?? 0,
    function: pos.name || frame.function } : frame;
}

export async function symbolicate(projectId: string, event: ErrorEvent): Promise<ErrorEvent> {
  const frames: ErrorFrame[] = [];
  for (const frame of event.frames) {
    try {
      const rows = await (await getDb()).query(`SELECT object_key,digest FROM error_sourcemaps
        WHERE project_id=$1 AND release=$2 AND file=$3`, [projectId, event.release, errorFile(frame.file)]);
      const row = rows[0];
      if (!row) { frames.push(frame); continue; }
      let consumer = cache.get(row.object_key);
      if (!consumer) {
        const stream = await getUploadStore().get(row.object_key);
        if (!stream) { frames.push(frame); continue; }
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of stream) {
          const b = Buffer.from(chunk); bytes += b.length;
          if (bytes > MAX_MAP_BYTES) { stream.destroy(); throw new Error('Map too large'); }
          chunks.push(b);
        }
        consumer = new SourceMapConsumer(parseSourceMap(Buffer.concat(chunks).toString('utf8')));
        if (cache.size >= 16) cache.delete(cache.keys().next().value);
        cache.set(row.object_key, consumer);
      }
      frames.push(mapFrame(frame, consumer));
    } catch { frames.push(frame); } // raw frame survives missing maps / storage outages
  }
  return { ...event, frames };
}
