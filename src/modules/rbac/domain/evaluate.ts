import type { PermissionDef } from '../../../core/module/types.js';
import type { Role } from '../../../core/security/types.js';

export interface Override {
  level: 'branch' | 'user';
  branchId?: string | null;
  role?: Role | null;
  userId?: string | null;
  key: string;
  effect: 'allow' | 'deny';
}

export interface Subject {
  id: string;
  role: Role;
  branchIds: string[];
}

export type Source = 'role' | 'branch' | 'user' | 'super_admin' | 'reserved';

/**
 * 02-requirements §3.3: user override → branch override (user's role, any of user's branches;
 * deny wins when branches disagree) → role default. Super admin allows everything except reserved keys.
 * Reserved keys (microfinance.*) are never granted, whatever the overrides say.
 */
export function evaluate(subject: Subject, def: PermissionDef, overrides: Override[]): { allowed: boolean; source: Source } {
  if (def.reserved) return { allowed: false, source: 'reserved' };
  if (subject.role === 'super_admin') return { allowed: true, source: 'super_admin' };
  const user = overrides.find((o) => o.level === 'user' && o.userId === subject.id && o.key === def.key);
  if (user) return { allowed: user.effect === 'allow', source: 'user' };
  const branch = overrides.filter(
    (o) => o.level === 'branch' && o.key === def.key && o.role === subject.role && !!o.branchId && subject.branchIds.includes(o.branchId),
  );
  if (branch.length) return { allowed: !branch.some((o) => o.effect === 'deny'), source: 'branch' };
  return { allowed: def.defaults[subject.role] === true, source: 'role' };
}

export function effectiveSet(subject: Subject, catalog: PermissionDef[], overrides: Override[]): Set<string> {
  return new Set(catalog.filter((d) => evaluate(subject, d, overrides).allowed).map((d) => d.key));
}
