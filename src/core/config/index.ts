import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    PROCESS_ROLE: z.enum(['api', 'worker']).default('api'),
    PORT: z.coerce.number().int().default(4000),
    // Unset on Vercel: falls back to the project's production URL (see the transform below).
    PUBLIC_BASE_URL: z.string().url().optional(),
    // Set by Vercel at runtime ("1" and the production host name); used only for defaults.
    VERCEL: z.string().optional(),
    VERCEL_PROJECT_PRODUCTION_URL: z.string().optional(),
    ADMIN_WEB_ORIGIN: z.string().default('http://localhost:3000'),
    COOKIE_DOMAIN: z.string().optional(),
    MONGODB_URI: z.string().default('mongodb://localhost:27017/?replicaSet=rs0'),
    MONGODB_DB_NAME: z.string().default('field_ops'),
    // ADR-063: each process (each Vercel function instance) keeps at most this many Mongo connections, and
    // closes one idle for this long. The driver default (100, never idle-closed) let busy hours open hundreds of
    // connections across instances and hit the Atlas connection limit.
    MONGODB_MAX_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),
    MONGODB_MAX_IDLE_MS: z.coerce.number().int().min(1000).default(60000),
    JWT_PRIVATE_KEY: z.string().optional(),
    JWT_PUBLIC_KEY: z.string().optional(),
    JWT_KEY_ID: z.string().default('dev'),
    ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().positive().default(900),
    REFRESH_TOKEN_TTL_DAYS_APP: z.coerce.number().int().positive().default(30),
    REFRESH_TOKEN_TTL_HOURS_WEB: z.coerce.number().int().positive().default(12),
    ERP_BASE_URL: z.string().optional(),
    ERP_API_TOKEN: z.string().optional(),
    ERP_API_TOKEN_NEXT: z.string().optional(),
    ERP_MODE: z.enum(['live', 'record_only', 'mock']).default('mock'),
    ERP_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
    S3_ENDPOINT: z.string().optional(),
    S3_REGION: z.string().default('auto'),
    S3_BUCKET_MEDIA: z.string().default('fos-media'),
    S3_BUCKET_EXPORTS: z.string().default('fos-exports'),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    // s3 | db (files in MongoDB, for hosts without S3) | memory (development). Empty = chosen automatically.
    STORAGE_DRIVER: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['s3', 'db', 'memory', 'cloudinary']).optional()),
    // Cloudinary (ADR-050): photos are copied there after upload when all three are set. The secret is never logged.
    CLOUDINARY_CLOUD_NAME: z.preprocess(blank, z.string().regex(/^[a-z0-9_-]+$/i, 'cloud name').optional()),
    CLOUDINARY_API_KEY: z.preprocess(blank, z.string().optional()),
    CLOUDINARY_API_SECRET: z.preprocess(blank, z.string().optional()),
    CLOUDINARY_FOLDER: z.preprocess(blank, z.string().regex(/^[\w-]+(\/[\w-]+)*$/, 'folder like fos or fos/media').default('fos')),
    FCM_PROJECT_ID: z.string().optional(),
    FCM_SERVICE_ACCOUNT_JSON: z.string().optional(),
    SENTRY_DSN: z.string().optional(),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    TZ_BUSINESS: z.literal('Asia/Dhaka').default('Asia/Dhaka'),
    // Unset = true on Vercel (its edge overwrites X-Forwarded-For with the client IP), false elsewhere. Without it
    // every request seems to come from Vercel's proxy, so all staff would share one login-throttle IP (ADR-064).
    TRUST_PROXY: z.preprocess(blank, bool.optional()),
  })
  .superRefine((env, ctx) => {
    // Production must never run with dev conveniences (ephemeral keys, mock ERP).
    if (env.NODE_ENV === 'production') {
      if (!env.JWT_PRIVATE_KEY || !env.JWT_PUBLIC_KEY)
        ctx.addIssue({ code: 'custom', message: 'JWT keys are required in production', path: ['JWT_PRIVATE_KEY'] });
      if (env.ERP_MODE === 'mock')
        ctx.addIssue({ code: 'custom', message: 'ERP_MODE=mock is not allowed in production', path: ['ERP_MODE'] });
    }
    // record_only reads the real ERP too (only posting waits), so it needs the same two values.
    if ((env.ERP_MODE === 'live' || env.ERP_MODE === 'record_only') && (!env.ERP_BASE_URL || !env.ERP_API_TOKEN))
      ctx.addIssue({ code: 'custom', message: 'ERP_BASE_URL and ERP_API_TOKEN required for live and record_only modes', path: ['ERP_MODE'] });
  })
  .transform((env) => ({
    ...env,
    TRUST_PROXY: env.TRUST_PROXY ?? !!env.VERCEL,
    PUBLIC_BASE_URL: env.PUBLIC_BASE_URL ?? (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : 'http://localhost:4000'),
  }));

export type Config = z.infer<typeof schema>;

/** Cloudinary is on only when the cloud name, key and secret are all set (ADR-050). */
export function cloudinaryConfigured(c: Pick<Config, 'CLOUDINARY_CLOUD_NAME' | 'CLOUDINARY_API_KEY' | 'CLOUDINARY_API_SECRET'>): boolean {
  return !!(c.CLOUDINARY_CLOUD_NAME && c.CLOUDINARY_API_KEY && c.CLOUDINARY_API_SECRET);
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${msg}`);
  }
  return parsed.data;
}
