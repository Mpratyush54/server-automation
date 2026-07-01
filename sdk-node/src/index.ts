import { PlatformClient } from './client';

const platform = new PlatformClient();
export default platform;
export { PlatformClient } from './client';
export { PostgresManager } from './db/postgres';
export { MongoManager } from './db/mongo';
export { RedisManager } from './db/redis';
export { StorageClient } from './storage';
export { ConfigClient } from './config';
export { LoggerClient, logger } from './logger';
export { MetricsClient, metricsClient, normalizePath } from './metrics';
export { captureConsole } from './console-capture';
export { createWinstonTransport, createPinoTransport } from './transports';
