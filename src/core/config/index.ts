import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    PROCESS_ROLE: z.enum(['api', 'worker']).default('api'),
    PORT: z.coerce.number().int().default(4000),
    PUBLIC_BASE_URL: z.string().url().default('http://localhost:4000'),
    ADMIN_WEB_ORIGIN: z.string().default('http://localhost:3000'),
    COOKIE_DOMAIN: z.string().optional(),
    MONGODB_URI: z.string().default('mongodb://localhost:27017/?replicaSet=rs0'),
    MONGODB_DB_NAME: z.string().default('field_ops'),
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
    FCM_PROJECT_ID: z.string().optional(),
    FCM_SERVICE_ACCOUNT_JSON: z.string().optional(),
    SENTRY_DSN: z.string().optional(),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    TZ_BUSINESS: z.literal('Asia/Dhaka').default('Asia/Dhaka'),
    TRUST_PROXY: bool.default('false'),
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
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${msg}`);
  }
  return parsed.data;
}
