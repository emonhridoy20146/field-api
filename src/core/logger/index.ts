import pino, { type Logger } from 'pino';

/** Never log tokens, passwords, phone numbers or photo URLs (CLAUDE.md §3). */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'password',
  '*.password',
  '*.currentPassword',
  '*.newPassword',
  'refreshToken',
  '*.refreshToken',
  'accessToken',
  '*.accessToken',
  '*.uploadUrl',
  '*.url',
];

export function createLogger(level: string): Logger {
  return pino({ level, redact: { paths: REDACT_PATHS, censor: '[redacted]' }, base: { service: 'field-api' } });
}

export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '';
  if (phone.length < 8) return '****';
  return `${phone.slice(0, 6)}****${phone.slice(-4)}`;
}

export type { Logger };
