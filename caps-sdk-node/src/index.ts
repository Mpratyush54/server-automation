import { CapsClient } from './client';

const caps = new CapsClient();
export default caps;
export { CapsClient } from './client';
export { PostgresManager } from './db/postgres';
export { MongoManager } from './db/mongo';
export { RedisManager } from './db/redis';
export { StorageClient } from './storage';
export { ConfigClient } from './config';
export { LoggerClient, logger } from './logger';
export { MetricsTracker, metricsTracker, normalizePath } from './metrics';
export { captureConsole } from './console-capture';
export { createWinstonTransport, createPinoTransport } from './transports';
