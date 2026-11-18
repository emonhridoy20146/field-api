/**
 * `pnpm keys:jwt`: prints a fresh Ed25519 pair as base64 PEM for JWT_PRIVATE_KEY / JWT_PUBLIC_KEY.
 * Needed on any multi-instance host (Vercel): ephemeral dev keys differ per instance.
 * Paste the values into the host's environment settings; never commit them.
 */
import { generateKeyPairSync, randomUUID } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const b64 = (pem: string) => Buffer.from(pem).toString('base64');
console.log(`JWT_PRIVATE_KEY=${b64(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())}`);
console.log(`JWT_PUBLIC_KEY=${b64(publicKey.export({ type: 'spki', format: 'pem' }).toString())}`);
console.log(`JWT_KEY_ID=${randomUUID().slice(0, 8)}`);
