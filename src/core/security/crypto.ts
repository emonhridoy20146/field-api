import { createHash, randomBytes, randomInt } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

// argon2id with OWASP-recommended minimums (m=19 MiB, t=2, p=1).
const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;
export const hashPassword = (pw: string) => hash(pw, ARGON);
export const verifyPassword = async (hashStr: string, pw: string) => {
  try {
    return await verify(hashStr, pw);
  } catch {
    return false;
  }
};

/** Human-friendly temporary password, e.g. "Kp7-xq4-Mz9" (no ambiguous characters). */
export function temporaryPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const part = () => Array.from({ length: 3 }, () => alphabet[randomInt(alphabet.length)]).join('');
  return `${part()}-${part()}-${part()}`;
}

/** Normalise BD mobile numbers: 01XXXXXXXXX / 8801… / +8801… → +8801XXXXXXXXX. */
export function normalizeBdPhone(input: string): string | null {
  const digits = input.replace(/[\s-]/g, '');
  const m = /^(?:\+?88)?(01[3-9]\d{8})$/.exec(digits);
  return m ? `+88${m[1]}` : null;
}
