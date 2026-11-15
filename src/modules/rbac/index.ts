/** Public API of the rbac module. */
export { can, effectivePermissions, catalog, permissionsVersion, holdersOf, invalidate as invalidatePermissions } from './service.js';
export { evaluate, effectiveSet, type Override } from './domain/evaluate.js';
