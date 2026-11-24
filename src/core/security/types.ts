export type Role = 'super_admin' | 'area_manager' | 'branch_manager' | 'field_staff' | 'viewer';
export const ROLES: Role[] = ['super_admin', 'area_manager', 'branch_manager', 'field_staff', 'viewer'];

/**
 * Roles whose scope is every branch, present and future (ADR-065). `user.branchIds` of these roles is only their home
 * branch (where their own records, e.g. a request they create, belong); it never narrows what they see.
 * This table is the one place scope depends on a role; business logic asks `hasAllBranches`, never a role name.
 */
export const ALL_BRANCH_ROLES: readonly Role[] = ['super_admin', 'area_manager'];

/** Roles only a super admin may create, edit, re-role, reset or deactivate (FR-USER-*, ADR-065). */
export const OFFICE_ADMIN_ROLES: readonly Role[] = ['super_admin', 'area_manager', 'branch_manager'];

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

export const isSuperAdmin = (u: { role: Role }) => u.role === 'super_admin';

/** Every branch is in scope (super admin, area manager; ADR-065). */
export const hasAllBranches = (u: { role: Role }) => ALL_BRANCH_ROLES.includes(u.role);

/** Branch filter for branch-scoped documents: all-branch roles → all, others → their branches. */
export function branchFilter(u: AuthUser, field = 'branchId'): Record<string, unknown> {
  return hasAllBranches(u) ? {} : { [field]: { $in: u.branchIds } };
}

export function canSeeBranch(u: { role: Role; branchIds: string[] }, branchId: string | null | undefined): boolean {
  return hasAllBranches(u) || (!!branchId && u.branchIds.includes(branchId));
}

/** Two users share a branch, or the actor sees every branch (user/device/session scope). */
export function sharesBranch(actor: { role: Role; branchIds: string[] }, target: { branchIds: string[] }): boolean {
  return hasAllBranches(actor) || target.branchIds.some((b) => actor.branchIds.includes(b));
}

/** Narrow by ?branchId= while staying inside scope; out of scope → empty result (never leaks). */
export function branchQuery(u: AuthUser, requested: string | undefined, field = 'branchId'): Record<string, unknown> {
  if (!requested) return branchFilter(u, field);
  return canSeeBranch(u, requested) ? { [field]: requested } : { [field]: { $in: [] } };
}
