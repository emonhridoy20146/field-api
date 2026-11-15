import mongoose, { type ClientSession } from 'mongoose';

mongoose.set('strictQuery', true);
mongoose.set('autoIndex', false); // indexes come from migrations

export async function connectMongo(uri: string, dbName: string): Promise<typeof mongoose> {
  return mongoose.connect(uri, { dbName, serverSelectionTimeoutMS: 10000, retryWrites: true });
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
