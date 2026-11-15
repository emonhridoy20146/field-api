export type Role = 'super_admin' | 'branch_manager' | 'field_staff' | 'viewer';
export const ROLES: Role[] = ['super_admin', 'branch_manager', 'field_staff', 'viewer'];

export interface AuthUser {
  id: string;
  role: Role;
  branchIds: string[];
  name: { bn?: string; en?: string };
  employeeCode: string;
  sessionId: string;
  deviceId: string | null;
  client: 'app' | 'web';
  mustChangePassword: boolean;
  locale: 'bn' | 'en';
}

export const isSuperAdmin = (u: AuthUser) => u.role === 'super_admin';

/** Branch filter for branch-scoped documents: SA → all, others → their branches. */
export function branchFilter(u: AuthUser, field = 'branchId'): Record<string, unknown> {
  return isSuperAdmin(u) ? {} : { [field]: { $in: u.branchIds } };
}

export function canSeeBranch(u: AuthUser, branchId: string | null | undefined): boolean {
  return isSuperAdmin(u) || (!!branchId && u.branchIds.includes(branchId));
}

/** Narrow by ?branchId= while staying inside scope; out of scope → empty result (never leaks). */
export function branchQuery(u: AuthUser, requested: string | undefined, field = 'branchId'): Record<string, unknown> {
  if (!requested) return branchFilter(u, field);
  return canSeeBranch(u, requested) ? { [field]: requested } : { [field]: { $in: [] } };
}
