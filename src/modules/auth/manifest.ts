import type { ModuleManifest } from '../../core/module/types.js';
import { ctx } from '../../core/context/index.js';
import { indexMigration } from '../../core/db/migrations.js';
import { authRoutes } from './routes.js';
import { resolveAuthUser, revokeAllForUser } from './service.js';

export const manifest: ModuleManifest = {
  name: 'auth',
  version: '1.0.0',
  core: true,
  description: 'Login, rotating refresh tokens, password change, sessions (FR-AUTH-*)',
  dependsOn: ['audit', 'users', 'rbac', 'flags'],
  permissions: [],
  routes: authRoutes,
  events: { emits: ['auth.login', 'auth.login_failed', 'auth.session_revoked'], consumes: ['user.deactivated', 'user.password_reset'] },
  migrations: [
    indexMigration('20261115-0001-auth-indexes', [
      { collection: 'sessions', key: { refreshTokenHash: 1 }, options: { unique: true } },
      { collection: 'sessions', key: { previousTokenHashes: 1 } },
      { collection: 'sessions', key: { userId: 1, revokedAt: 1 } },
      { collection: 'sessions', key: { familyId: 1 } },
      { collection: 'sessions', key: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } },
      { collection: 'login_attempts', key: { key: 1, at: -1 } },
      { collection: 'login_attempts', key: { at: 1 }, options: { expireAfterSeconds: 86400 } },
    ]),
  ],
  init() {
    ctx().ports.loadAuthUser = resolveAuthUser;
    // FR-USER-002: deactivation revokes all sessions; an admin reset forces re-login everywhere.
    ctx().bus.on('user.deactivated', async (p) => void (await revokeAllForUser(p.userId as string, 'user_deactivated')));
    ctx().bus.on('user.password_reset', async (p) => void (await revokeAllForUser(p.userId as string, 'password_reset')));
  },
};
