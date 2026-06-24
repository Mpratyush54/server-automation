import { initKubernetes, isKubernetesConnected } from './kubernetes';
import { connectAll, disconnectAll, healthCheckAll, ConnectionConfig } from './connections';
import { connectMongo } from './mongoose';

export async function initDatabase() {
  console.log('[caps] Initializing platform connections...');

  // Connect to MongoDB
  try {
    await connectMongo();
    console.log('[caps] MongoDB connected');
  } catch (err: any) {
    console.warn('[caps] MongoDB connection failed:', err.message);
  }

  // Connect to databases from environment
  const dbConfig: ConnectionConfig = {};

  if (process.env.CAPS_PG_HOST) {
    dbConfig.postgres = {
      host: process.env.CAPS_PG_HOST,
      port: parseInt(process.env.CAPS_PG_PORT || '5432'),
      user: process.env.CAPS_PG_USER || 'caps',
      password: process.env.CAPS_PG_PASSWORD || 'caps',
      database: process.env.CAPS_PG_DB || 'caps_platform',
      poolSize: parseInt(process.env.CAPS_PG_POOL || '10'),
    };
  }

  if (process.env.CAPS_MONGO_URI) {
    dbConfig.mongo = {
      uri: process.env.CAPS_MONGO_URI,
      poolSize: parseInt(process.env.CAPS_MONGO_POOL || '5'),
    };
  }

  if (process.env.CAPS_REDIS_HOST) {
    dbConfig.redis = {
      host: process.env.CAPS_REDIS_HOST,
      port: parseInt(process.env.CAPS_REDIS_PORT || '6379'),
      password: process.env.CAPS_REDIS_PASSWORD,
      db: parseInt(process.env.CAPS_REDIS_DB || '0'),
    };
  }

  if (Object.keys(dbConfig).length > 0) {
    await connectAll(dbConfig);
  }

  // Initialize Kubernetes
  try {
    const k8sConnected = await initKubernetes();
    if (k8sConnected) {
      console.log('[caps] Kubernetes connected');
    } else {
      console.warn('[caps] Kubernetes not available (kubeconfig missing or invalid)');
    }
  } catch (err: any) {
    console.warn('[caps] Kubernetes init failed:', err.message);
  }

  console.log('[caps] Platform initialization complete');
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
  console.log('[caps] Shutting down platform connections...');
  await disconnectAll();
  console.log('[caps] Platform shutdown complete');
}
