import mongoose, { Connection } from 'mongoose';

export class MongoManager {
  private conn: Connection | null = null;
  private connected = false;
  private retryCount = 0;
  private maxRetries = 5;
  private uri: string;

  constructor(config: any = {}) {
    this.uri = config.uri || process.env.PLATFORM_MONGO_URI || 'mongodb://localhost:27017/platform';
  }

  async connect(): Promise<void> {
    try {
      this.conn = await mongoose.createConnection(this.uri).asPromise();
      this.connected = true;
      this.retryCount = 0;
      console.log('[platform] MongoDB connected');
    } catch (err: any) {
      console.error('[platform] MongoDB connection failed:', err.message);
      this.connected = false;
      this.scheduleReconnect();
    }
  }

  get db(): Connection | null {
    return this.conn;
  }

  private scheduleReconnect(): void {
    if (this.retryCount >= this.maxRetries) return;
    const delay = Math.min(1000 * Math.pow(2, this.retryCount), 30000);
    this.retryCount++;
    setTimeout(() => this.connect(), delay);
  }

  async disconnect(): Promise<void> {
    if (this.conn) {
      await this.conn.close();
      this.connected = false;
      console.log('[platform] MongoDB disconnected');
    }
  }

  get isConnected(): boolean { return this.connected; }
  get health(): { connected: boolean } {
    return { connected: this.connected };
  }
}
