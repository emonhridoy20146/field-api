import { SignJWT, jwtVerify, generateKeyPair, importPKCS8, importSPKI, errors, type CryptoKey, type KeyObject } from 'jose';
import type { Config } from '../config/index.js';
import { AppError } from '../errors/index.js';
import type { Role } from './types.js';

type Key = CryptoKey | KeyObject;
let keys: { priv: Key; pub: Key; kid: string } | null = null;
const ALG = 'EdDSA';

export interface AccessClaims {
  sub: string;
  sid: string;
  role: Role;
}

const decodePem = (v: string) => (v.includes('BEGIN') ? v : Buffer.from(v, 'base64').toString('utf8'));

export async function initJwtKeys(config: Config): Promise<void> {
  if (config.JWT_PRIVATE_KEY && config.JWT_PUBLIC_KEY) {
    keys = {
      priv: await importPKCS8(decodePem(config.JWT_PRIVATE_KEY), ALG),
      pub: await importSPKI(decodePem(config.JWT_PUBLIC_KEY), ALG),
      kid: config.JWT_KEY_ID,
    };
    return;
  }
  // Development/test only (config refuses production without keys): ephemeral keys, tokens die on restart.
  const kp = await generateKeyPair(ALG, { crv: 'Ed25519' });
  keys = { priv: kp.privateKey, pub: kp.publicKey, kid: 'ephemeral' };
}

function k() {
  if (!keys) throw new Error('JWT keys not initialised');
  return keys;
}

export async function signAccessToken(claims: AccessClaims, now: Date, ttlSec: number): Promise<{ token: string; expiresAt: Date }> {
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + ttlSec;
  const token = await new SignJWT({ sid: claims.sid, role: claims.role })
    .setProtectedHeader({ alg: ALG, kid: k().kid })
    .setSubject(claims.sub)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setIssuer('field-api')
    .setAudience('fos')
    .sign(k().priv);
  return { token, expiresAt: new Date(exp * 1000) };
}

export async function verifyAccessToken(token: string, now: Date): Promise<AccessClaims> {
  try {
    const { payload } = await jwtVerify(token, k().pub, {
      issuer: 'field-api',
      audience: 'fos',
      currentDate: now,
      algorithms: [ALG],
    });
    if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') throw new AppError('UNAUTHENTICATED');
    return { sub: payload.sub, sid: payload.sid, role: payload.role as Role };
  } catch (e) {
    if (e instanceof AppError) throw e;
    if (e instanceof errors.JWTExpired) throw new AppError('TOKEN_EXPIRED');
    throw new AppError('UNAUTHENTICATED');
  }
}
