/** Public API of the requests module: only what other modules need. Never export from models/. */
import type { AuthUser } from '../../core/security/types.js';
import { dashboardStats } from './service.js';

/**
 * Dashboard counters for the reports module (contract 1.48.0 `requestStats`), scoped like GET /requests: requests not
 * resolved or closed, by where they wait now (area manager queue, super admin queue, with a person), and the important ones.
 */
export function requestDashboardStats(user: AuthUser, branchId: string | undefined): Promise<{ areaManagerQueue: number; superAdminQueue: number; assigned: number; importantOpen: number }> {
  return dashboardStats(user, branchId);
}
export { OPEN_STATUSES as OPEN_REQUEST_STATUSES, type RequestStatus } from './domain/rules.js';
