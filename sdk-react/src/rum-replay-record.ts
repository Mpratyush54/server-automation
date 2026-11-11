/**
 * rrweb recorder + gzip for session replay (#40). Loaded only through
 * `import('./rum-replay-record')` from rum-replay.ts, after the session is sampled
 * in and replay consent is given, so bundlers emit it as a separate lazy chunk.
 *
 * The record options (masking, blocking, sampling) come from
 * `buildRecordOptions` in rum-replay.ts and are applied verbatim.
 *
 * NOTE: shared verbatim between sdk-react and sdk-angular.
 */
import { record } from '@rrweb/record';
import { gzipSync, strToU8 } from 'fflate';
import type { ReplayRecorder } from './rum-replay';

/** Gzip a chunk envelope (level 6: good ratio, a few ms for 64 KiB). */
export function gzip(text: string): Uint8Array {
  return gzipSync(strToU8(text), { level: 6 });
}

export function startRecorder(config: Record<string, unknown>, emit: (event: any, isCheckout?: boolean) => void): ReplayRecorder {
  const stop = record({ ...(config as any), emit });
  return {
    stop: () => {
      if (stop) stop();
    },
    addCustomEvent: (tag: string, payload: unknown) => {
      record.addCustomEvent(tag, payload);
    },
    takeFullSnapshot: (isCheckout?: boolean) => {
      record.takeFullSnapshot(isCheckout);
    },
  };
}
