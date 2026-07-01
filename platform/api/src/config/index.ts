import { initKubernetes, isKubernetesConnected } from './kubernetes';
import { connectAll, disconnectAll, healthCheckAll, ConnectionConfig } from './connections';
import { connectMongo } from './mongoose';

export async function initDatabase() {
  console.log('[platform] Initializing platform connections...');

  // Connect to MongoDB
  try {
    await connectMongo();
    console.log('[platform] MongoDB connected');
  } catch (err: any) {
    console.warn('[platform] MongoDB connection failed:', err.message);
  }

  // Connect to databases from environment
  const dbConfig: ConnectionConfig = {};

  if (process.env.PLATFORM_PG_HOST) {
    dbConfig.postgres = {
      host: process.env.PLATFORM_PG_HOST,
      port: parseInt(process.env.PLATFORM_PG_PORT || '5432'),
      user: process.env.PLATFORM_PG_USER || 'plat',
      password: process.env.PLATFORM_PG_PASSWORD || 'plat',
      database: process.env.PLATFORM_PG_DB || 'plat_platform',
      poolSize: parseInt(process.env.PLATFORM_PG_POOL || '10'),
    };
  }

  if (process.env.PLATFORM_MONGO_URI) {
    dbConfig.mongo = {
      uri: process.env.PLATFORM_MONGO_URI,
      poolSize: parseInt(process.env.PLATFORM_MONGO_POOL || '5'),
    };
  }

  if (process.env.PLATFORM_REDIS_HOST) {
    dbConfig.redis = {
      host: process.env.PLATFORM_REDIS_HOST,
      port: parseInt(process.env.PLATFORM_REDIS_PORT || '6379'),
      password: process.env.PLATFORM_REDIS_PASSWORD,
      db: parseInt(process.env.PLATFORM_REDIS_DB || '0'),
    };
  }

  if (Object.keys(dbConfig).length > 0) {
    await connectAll(dbConfig);
  }

  // Initialize Kubernetes
  try {
    const k8sConnected = await initKubernetes();
    if (k8sConnected) {
      console.log('[platform] Kubernetes connected');
    } else {
      console.warn('[platform] Kubernetes not available (kubeconfig missing or invalid)');
    }
  } catch (err: any) {
    console.warn('[platform] Kubernetes init failed:', err.message);
  }

  console.log('[platform] Platform initialization complete');
}

export async function getHealthStatus() {
  const dbHealth = await healthCheckAll();
  const k8sConnected = isKubernetesConnected();

  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    databases: dbHealth,
    kubernetes: {
      connected: k8sConnected,
    },
  };
}

export async function shutdownPlatform() {
  console.log('[platform] Shutting down platform connections...');
  await disconnectAll();
  console.log('[platform] Platform shutdown complete');
}
