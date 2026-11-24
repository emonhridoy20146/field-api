import mongoose, { type ClientSession } from 'mongoose';

mongoose.set('strictQuery', true);
mongoose.set('autoIndex', false); // indexes come from migrations

export interface MongoPool {
  maxPoolSize?: number;
  maxIdleTimeMS?: number;
}

/**
 * Connection options (ADR-063). The pool is bounded per process and idle sockets are closed, because on Vercel
 * every function instance has its own pool: with the driver default (maxPoolSize 100, no idle timeout) busy hours
 * reached the Atlas connection limit and the database refused new connections. minPoolSize 0 keeps a frozen or
 * quiet instance from holding sockets open.
 */
export function mongoOptions(dbName: string, pool: MongoPool = {}) {
  return {
    dbName,
    serverSelectionTimeoutMS: 10000,
    retryWrites: true,
    maxPoolSize: pool.maxPoolSize ?? 10,
    minPoolSize: 0,
    maxIdleTimeMS: pool.maxIdleTimeMS ?? 60000,
    // A request waits this long for a free connection instead of opening more.
    waitQueueTimeoutMS: 15000,
  };
}

export async function connectMongo(uri: string, dbName: string, pool: MongoPool = {}): Promise<typeof mongoose> {
  return mongoose.connect(uri, mongoOptions(dbName, pool));
}

/** The pool settings from the loaded config. */
export function poolFrom(config: { MONGODB_MAX_POOL_SIZE: number; MONGODB_MAX_IDLE_MS: number }): MongoPool {
  return { maxPoolSize: config.MONGODB_MAX_POOL_SIZE, maxIdleTimeMS: config.MONGODB_MAX_IDLE_MS };
}

export async function disconnectMongo(): Promise<void> {
  await mongoose.disconnect();
}

export function db() {
  const d = mongoose.connection.db;
  if (!d) throw new Error('Mongo not connected');
  return d;
}

/** Runs fn inside a Mongo transaction (Atlas replica set). Retries transient errors (driver default). */
export async function withTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  try {
    let result: T | undefined;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result as T;
  } finally {
    await session.endSession();
  }
}

export const isDuplicateKey = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && 'code' in e && (e as { code: unknown }).code === 11000;

export const oid = (s: string) => new mongoose.Types.ObjectId(s);
export const isOid = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{24}$/i.test(s);
export const newId = () => new mongoose.Types.ObjectId().toHexString();

export { mongoose };
export type { ClientSession };

/**
 * A `.lean()` document read without a typed schema. Mongoose infers awkward types for nested
 * and Mixed fields, so services read these loosely and convert to typed views at their edge.
 * This is the single place where `any` is allowed (CLAUDE.md §7).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LooseObject = Record<string, any>;
export type LeanDoc = LooseObject & { _id: { toHexString(): string } };
