import mongoose, { Connection } from 'mongoose';

export class MongoManager {
  private conn: Connection | null = null;
  private connected = false;
  private retryCount = 0;
  private maxRetries = 5;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private uri: string;

  constructor(config: any = {}) {
    this.uri = config.uri || process.env.PLATFORM_MONGO_URI || 'mongodb://localhost:27017/platform';
  }

  async connect(): Promise<void> {
    this.stopped = false;
    this.clearReconnectTimer();
    // Dispose any connection left over from a previous attempt before creating a new one.
    await this.disposeConnection();
    const pending = mongoose.createConnection(this.uri);
    pending.on('error', (err: Error) => {
      if (this.conn === pending) this.connected = false;
      console.error('[platform] MongoDB error:', err.message);
    });
    try {
      this.conn = await pending.asPromise();
      this.connected = true;
      this.retryCount = 0;
      console.log('[platform] MongoDB connected');
    } catch (err: any) {
      console.error('[platform] MongoDB connection failed:', err.message);
      this.connected = false;
      try { await (pending as any).close?.(); } catch {}
      this.scheduleReconnect();
    }
  }

  get db(): Connection | null {
    return this.conn;
  }

  private async disposeConnection(): Promise<void> {
    const old = this.conn;
    this.conn = null;
    if (old) {
      try { await old.close(); } catch {}
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retryCount >= this.maxRetries) return;
    const delay = Math.min(1000 * Math.pow(2, this.retryCount), 30000);
    this.retryCount++;
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect().catch(() => {});
    }, delay);
    (this.reconnectTimer as any).unref?.();
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    this.clearReconnectTimer();
    if (this.conn) {
      await this.disposeConnection();
      this.connected = false;
      console.log('[platform] MongoDB disconnected');
    }
  }

  get isConnected(): boolean { return this.connected; }
  get health(): { connected: boolean } {
    return { connected: this.connected };
  }
}
