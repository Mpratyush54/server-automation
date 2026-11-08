import fs from 'fs';
import os from 'os';
import { setLeaderGauge } from './job-metrics';
import { loadKubeConfig } from './kube-config';

/**
 * Leader election on a coordination.k8s.io/v1 Lease.
 *
 * Every API replica runs one elector. Exactly one replica holds the Lease
 * (`platform-api-leader` in the API's own namespace) at a time; periodic and
 * recovery work registered through `onLeadershipChange` runs only there.
 *
 * Timing (defaults): lease 10 s, renew/retry every 2 s. A leader that cannot
 * renew for a full lease duration steps down on its own; a follower takes over
 * once the holder's record has not changed for a full lease duration
 * (measured on the follower's own clock, like client-go, so clock skew between
 * nodes does not matter). A graceful shutdown releases the Lease, so takeover
 * is then immediate. Worst case after a hard kill: lease + retry ≈ 12 s.
 *
 * Outside Kubernetes (local dev, tests) or with LEADER_ELECTION=disabled the
 * process is always the leader — a single process is trivially exactly-once.
 */

export const DEFAULT_LEASE_NAME = 'platform-api-leader';

/** Minimal slice of CoordinationV1Api used here (lets tests inject a fake). */
export interface LeaseApi {
  readNamespacedLease(p: { name: string; namespace: string }): Promise<any>;
  createNamespacedLease(p: { namespace: string; body: any }): Promise<any>;
  replaceNamespacedLease(p: { name: string; namespace: string; body: any }): Promise<any>;
}

export interface LeaderElectorOptions {
  api: LeaseApi;
  namespace: string;
  identity: string;
  leaseName?: string;
  leaseDurationMs?: number;
  retryPeriodMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

export type LeadershipListener = (isLeader: boolean) => void;

/** k8s MicroTime needs exactly six fractional digits on the wire. */
class MicroTime extends Date {
  toISOString(): string {
    return super.toISOString().slice(0, -1) + '000Z';
  }
  toJSON(): string {
    return this.toISOString();
  }
}

function errCode(err: any): number | undefined {
  const c = err?.code ?? err?.statusCode ?? err?.response?.statusCode ?? err?.body?.code;
  return typeof c === 'number' ? c : undefined;
}

export class LeaderElector {
  readonly identity: string;
  readonly namespace: string;
  readonly leaseName: string;
  readonly leaseDurationMs: number;
  readonly retryPeriodMs: number;
  /** A leader that has not renewed for this long steps down (< lease duration). */
  readonly renewDeadlineMs: number;

  private readonly api: LeaseApi;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly listeners = new Set<LeadershipListener>();

  private leader = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;
  /** Last successful renew of our own lease (local clock). */
  private lastRenewAt = 0;
  /** Last observed foreign lease record, and when we first saw it (local clock). */
  private observedKey = '';
  private observedAt = 0;

  constructor(opts: LeaderElectorOptions) {
    this.api = opts.api;
    this.namespace = opts.namespace;
    this.identity = opts.identity;
    this.leaseName = opts.leaseName || DEFAULT_LEASE_NAME;
    this.leaseDurationMs = opts.leaseDurationMs ?? 10_000;
    this.retryPeriodMs = opts.retryPeriodMs ?? 2_000;
    this.renewDeadlineMs = Math.max(this.retryPeriodMs, this.leaseDurationMs - 2 * this.retryPeriodMs);
    this.now = opts.now || Date.now;
    this.log = opts.log || ((m) => console.log(`[leader] ${m}`));
  }

  /**
   * True while we hold the Lease. Also false once our last renew is older than
   * the renew deadline, even if the renew loop has not run yet (event-loop
   * stall, suspended process), so stale leaders do not start work.
   */
  isLeader(): boolean {
    return this.leader && this.now() - this.lastRenewAt < this.renewDeadlineMs;
  }

  onLeadershipChange(fn: LeadershipListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    const loop = async () => {
      if (!this.running) return;
      await this.tick();
      if (this.running) {
        this.timer = setTimeout(loop, this.retryPeriodMs);
        this.timer.unref?.();
      }
    };
    void loop();
  }

  /** Stop campaigning; if leader, release the Lease so a peer can take over at once. */
  async stop(): Promise<void> {
    this.running = false;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.leader) {
      try {
        const lease = await this.api.readNamespacedLease({ name: this.leaseName, namespace: this.namespace });
        if (lease?.spec?.holderIdentity === this.identity) {
          lease.spec.holderIdentity = '';
          lease.spec.renewTime = new MicroTime(this.now());
          await this.api.replaceNamespacedLease({ name: this.leaseName, namespace: this.namespace, body: lease });
          this.log(`${this.identity} released ${this.namespace}/${this.leaseName}`);
        }
      } catch (err: any) {
        this.log(`release failed: ${err?.message || err}`);
      }
      this.setLeader(false);
    }
  }

  /** One acquire-or-renew attempt. Exposed for tests. */
  async tick(): Promise<boolean> {
    if (this.stopped) return false;
    const startedAt = this.now();
    let ok = false;
    try {
      ok = await this.tryAcquireOrRenew();
    } catch (err: any) {
      this.log(`lease attempt failed: ${err?.message || err}`);
      ok = false;
    }
    if (this.stopped) return false; // stop() ran while this attempt was in flight
    if (ok) {
      this.lastRenewAt = startedAt;
      this.setLeader(true);
    } else if (this.leader && (this.lostTo || this.now() - this.lastRenewAt >= this.renewDeadlineMs)) {
      // A peer holds the Lease, or we could not renew before the renew deadline
      // (kept below the lease duration so we step down before a peer may take
      // over): step down.
      this.setLeader(false);
    }
    this.lostTo = false;
    return this.isLeader();
  }

  /** Set when the Lease is observed to be held by someone else (definitive loss). */
  private lostTo = false;

  private async tryAcquireOrRenew(): Promise<boolean> {
    const nowMs = this.now();
    let lease: any;
    try {
      lease = await this.api.readNamespacedLease({ name: this.leaseName, namespace: this.namespace });
    } catch (err: any) {
      if (errCode(err) !== 404) throw err;
      try {
        await this.api.createNamespacedLease({
          namespace: this.namespace,
          body: {
            apiVersion: 'coordination.k8s.io/v1',
            kind: 'Lease',
            metadata: { name: this.leaseName, namespace: this.namespace },
            spec: {
              holderIdentity: this.identity,
              leaseDurationSeconds: Math.ceil(this.leaseDurationMs / 1000),
              acquireTime: new MicroTime(nowMs),
              renewTime: new MicroTime(nowMs),
              leaseTransitions: 0,
            },
          },
        });
        return true;
      } catch (createErr: any) {
        if (errCode(createErr) === 409) return false; // a peer created it first
        throw createErr;
      }
    }

    const spec = lease?.spec || {};
    const holder: string = spec.holderIdentity || '';
    const key = `${holder}|${spec.renewTime ? new Date(spec.renewTime).getTime() : ''}|${lease?.metadata?.resourceVersion || ''}`;
    if (key !== this.observedKey) {
      this.observedKey = key;
      this.observedAt = nowMs;
    }

    if (holder && holder !== this.identity) {
      const durationMs = (spec.leaseDurationSeconds ? spec.leaseDurationSeconds * 1000 : this.leaseDurationMs);
      if (nowMs - this.observedAt < durationMs) {
        if (this.leader) this.lostTo = true;
        return false; // held by a live peer
      }
    }

    const next = {
      ...lease,
      spec: {
        ...spec,
        holderIdentity: this.identity,
        leaseDurationSeconds: Math.ceil(this.leaseDurationMs / 1000),
        renewTime: new MicroTime(nowMs),
        acquireTime: holder === this.identity && spec.acquireTime ? spec.acquireTime : new MicroTime(nowMs),
        leaseTransitions: holder === this.identity ? (spec.leaseTransitions || 0) : (spec.leaseTransitions || 0) + 1,
      },
    };
    try {
      // resourceVersion in metadata makes this a compare-and-swap: a concurrent
      // writer gets 409 Conflict, so two candidates can never both win.
      await this.api.replaceNamespacedLease({ name: this.leaseName, namespace: this.namespace, body: next });
      return true;
    } catch (err: any) {
      if (errCode(err) === 409) {
        if (this.leader) this.lostTo = true;
        return false;
      }
      throw err;
    }
  }

  private setLeader(value: boolean): void {
    if (this.leader === value) return;
    this.leader = value;
    setLeaderGauge(value);
    this.log(`${this.identity} ${value ? 'acquired' : 'lost'} leadership of ${this.namespace}/${this.leaseName}`);
    for (const fn of this.listeners) {
      try {
        fn(value);
      } catch (err: any) {
        this.log(`leadership listener failed: ${err?.message || err}`);
      }
    }
  }
}

/**
 * Always-leader stand-in for processes outside Kubernetes or with
 * LEADER_ELECTION=disabled.
 */
export class StaticLeader {
  private leader = false;
  private readonly listeners = new Set<LeadershipListener>();
  readonly identity = os.hostname();
  isLeader(): boolean { return this.leader; }
  onLeadershipChange(fn: LeadershipListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  start(): void {
    if (this.leader) return;
    this.leader = true;
    setLeaderGauge(true);
    for (const fn of this.listeners) fn(true);
  }
  async stop(): Promise<void> {
    if (!this.leader) return;
    this.leader = false;
    setLeaderGauge(false);
    for (const fn of this.listeners) fn(false);
  }
}

export type Leadership = Pick<LeaderElector, 'isLeader' | 'onLeadershipChange' | 'start' | 'stop'>;

const SA_NAMESPACE_FILE = '/var/run/secrets/kubernetes.io/serviceaccount/namespace';

function inCluster(): boolean {
  return !!process.env.KUBERNETES_SERVICE_HOST && fs.existsSync(SA_NAMESPACE_FILE);
}

function podNamespace(): string {
  if (process.env.POD_NAMESPACE) return process.env.POD_NAMESPACE;
  try {
    return fs.readFileSync(SA_NAMESPACE_FILE, 'utf8').trim() || 'platform';
  } catch {
    return 'platform';
  }
}

function numEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

let instance: Leadership | null = null;

/** Process-wide leadership handle (created on first use; call `.start()` once at boot). */
export function getLeadership(): Leadership {
  if (instance) return instance;
  const mode = (process.env.LEADER_ELECTION || 'auto').toLowerCase();
  if (mode === 'disabled' || mode === 'false' || mode === 'off' || (mode === 'auto' && !inCluster())) {
    instance = new StaticLeader();
    return instance;
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const k8s = require('@kubernetes/client-node');
  const kc = new k8s.KubeConfig();
  loadKubeConfig(kc);
  instance = new LeaderElector({
    api: kc.makeApiClient(k8s.CoordinationV1Api),
    namespace: process.env.LEADER_LEASE_NAMESPACE || podNamespace(),
    identity: process.env.POD_NAME || process.env.HOSTNAME || os.hostname(),
    leaseName: process.env.LEADER_LEASE_NAME || DEFAULT_LEASE_NAME,
    leaseDurationMs: numEnv('LEADER_LEASE_DURATION_SECONDS', 10) * 1000,
    retryPeriodMs: numEnv('LEADER_RETRY_PERIOD_SECONDS', 2) * 1000,
  });
  return instance;
}

export function isLeader(): boolean {
  return getLeadership().isLeader();
}

export function onLeadershipChange(fn: LeadershipListener): () => void {
  return getLeadership().onLeadershipChange(fn);
}

/** Test hook. */
export function setLeadershipForTests(l: Leadership | null): void {
  instance = l;
}
