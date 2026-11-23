/** Public API of the prospects module: only what other modules need. Never export from models/. */
import type { AuthUser } from '../../core/security/types.js';
import { dashboardStats } from './service.js';

/**
 * Dashboard counters for the reports module (contract 1.45.0 `prospectStats`), scoped like GET /prospects:
 * created in [from, to] (Dhaka creation date), converted in [from, to] (Dhaka conversion date), open now.
 */
export function prospectDashboardStats(user: AuthUser, branchId: string | undefined, from: string, to: string): Promise<{ created: number; converted: number; openNow: number }> {
  return dashboardStats(user, branchId, from, to);
}
export type { ProspectStatus } from './domain/rules.js';
