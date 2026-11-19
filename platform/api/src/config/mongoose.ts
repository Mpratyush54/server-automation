import mongoose from 'mongoose';

let cached = (global as any).mongoose;
if (!cached) cached = (global as any).mongoose = { conn: null, promise: null };

/**
 * Connects once and reuses the connection. A failed first connect is not
 * cached: mongoose does not retry an initial connection, so a cached rejection
 * failed every later call with the same error. On the ha force-stop test an
 * API pod started while one MongoDB member had no DNS record yet; its
 * telemetry forwarding and Mongo-backed reads kept failing with
 * "getaddrinfo ENOTFOUND mongodb-1..." for 40+ minutes after the member was back.
 */
export async function connectMongo() {
  if (cached.conn) return cached.conn;
  if (!cached.promise) {
    const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/plat_platform';
    cached.promise = mongoose.connect(uri);
  }
  try {
    cached.conn = await cached.promise;
  } catch (err) {
    cached.promise = null;
    throw err;
  }
  return cached.conn;
}
