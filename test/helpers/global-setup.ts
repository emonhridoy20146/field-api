import { MongoMemoryReplSet } from 'mongodb-memory-server';

let rs: MongoMemoryReplSet | null = null;

/** One single-node replica set for the whole run (transactions need a replica set). */
export async function setup({ provide }: { provide: (k: string, v: string) => void }) {
  if (process.env.TEST_MONGODB_URI) {
    provide('mongoUri', process.env.TEST_MONGODB_URI);
    return;
  }
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
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
