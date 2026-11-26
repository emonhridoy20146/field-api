import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

let rs: MongoMemoryReplSet | null = null;

/**
 * Tests freeze the app clock (test/helpers/app.ts, 2026-11-15), but MongoDB's TTL monitor deletes by wall-clock time
 * about once a minute. Once the real date passed the frozen one, every row whose TTL field is "expired" in real time
 * could vanish in the middle of a test: web sessions (expiresAt = frozen now + 12 h) gave random 401s, failed
 * login attempts (1 day TTL) dropped an IP lock. No test relies on TTL deletion, so the monitor is off for tests.
 */
async function disableTtlMonitor(uri: string): Promise<void> {
  const c = await mongoose.createConnection(uri).asPromise();
  try {
    await c.getClient().db('admin').command({ setParameter: 1, ttlMonitorEnabled: false });
  } finally {
    await c.close();
  }
}

/** One single-node replica set for the whole run (transactions need a replica set). */
export async function setup({ provide }: { provide: (k: string, v: string) => void }) {
  if (process.env.TEST_MONGODB_URI) {
    await disableTtlMonitor(process.env.TEST_MONGODB_URI);
    provide('mongoUri', process.env.TEST_MONGODB_URI);
    return;
  }
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await disableTtlMonitor(rs.getUri());
  provide('mongoUri', rs.getUri());
}

export async function teardown() {
  await rs?.stop();
}

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}
