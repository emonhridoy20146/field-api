import type { FastifyPluginAsync } from 'fastify';
import type { Migration } from '../db/migrations.js';
import type { JobDef } from '../jobs/index.js';
import type { AuthUser, Role } from '../security/types.js';
import type { RequestMeta } from '../http/router.js';

export interface I18n {
  en: string;
  bn: string;
}

export interface PermissionDef {
  key: string;
  description: I18n;
  defaults: Partial<Record<Role, boolean>>;
  reserved?: boolean;
}

export interface SettingDef {
  key: string; // namespaced, e.g. 'cash.limitMode'
  type: 'int' | 'number' | 'string' | 'bool' | 'enum' | 'json';
  default: unknown;
  enum?: string[];
  branchOverridable?: boolean;
  /** Included in /sync/pull settings for the mobile app. */
  exposeToApp?: boolean;
  description?: string;
}

export interface SyncEntityDef {
  entity: string; // as in openapi SyncChange.entity
  /** Load current representations for ids in this user's scope; missing ids become deletes. */
  load: (ids: string[], user: AuthUser) => Promise<Map<string, Record<string, unknown>>>;
  /** Full snapshot for /sync/bootstrap, paged by opaque cursor. */
  snapshot?: (user: AuthUser, cursor: string | null, limit: number) => Promise<{ items: Record<string, unknown>[]; nextCursor: string | null }>;
}

export interface SyncMutationResult {
  entityId: string;
  /** true when the underlying write already existed (clientId / idempotency key replay). */
  replayed?: boolean;
  status?: string;
  /** Business conflict that is stored, not rejected (e.g. a collection in conflict). */
  conflict?: { code: string; message?: I18n };
  /** Extra fields merged into the per-item push result. */
  extra?: Record<string, unknown>;
}

/**
 * One offline mutation kind accepted by POST /sync/push (FR-SYNC-002). The owning module validates the
 * payload with the same zod schema as its REST route; the sync module checks flag + permission first.
 */
export interface SyncMutationDef {
  entity: string; // as in openapi SyncMutation.entity
  /** Omit only for self-service actions the service itself restricts to the acting user. */
  permission?: string;
  apply: (user: AuthUser, payload: unknown, m: { mutationId: string; meta: RequestMeta }) => Promise<SyncMutationResult>;
}

export interface InboxTypeDef {
  type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
}

export interface NotificationTypeDef {
  type: string;
  critical?: boolean; // bypasses quiet hours (FR-NOT-004)
}

export interface ModuleManifest {
  name: string; // kebab-case, equals folder name
  version: string;
  core?: boolean; // core modules cannot be flagged off
  description: string;
  featureFlag?: { key: `module.${string}`; default: false; description: string; owner: string; reviewBy?: string; lockedReason?: string };
  dependsOn: string[];
  permissions: PermissionDef[];
  /** Fastify plugin mounted under /api/v1; routes declare full paths (a module may own several prefixes). */
  routes?: FastifyPluginAsync<RoutePluginOptions>;
  events?: { emits: string[]; consumes: string[] };
  jobs?: JobDef[];
  migrations?: Migration[];
  settings?: SettingDef[];
  syncEntities?: SyncEntityDef[];
  syncMutations?: SyncMutationDef[];
  inboxTypes?: InboxTypeDef[];
  notificationTypes?: NotificationTypeDef[];
  /** Called once at boot after all manifests validated: subscribe events, register ports/outbox handlers. */
  init?: () => Promise<void> | void;
}

export interface RoutePluginOptions {
  featureFlag?: string;
  moduleName: string;
}
