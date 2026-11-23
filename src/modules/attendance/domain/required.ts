/**
 * FR-ATT-014 (1.45.0, owner request 2026-11-23): who must do attendance. Decided by permission keys, never by role
 * name (CLAUDE.md §2.6): `attendance.record` and not `attendance.exempt` (granted to super admins by default; an admin
 * can grant or deny it per branch or user). `moduleOn` = the attendance module is switched on for the user.
 */
export function attendanceRequired(permissions: ReadonlySet<string>, moduleOn: boolean): boolean {
  return moduleOn && permissions.has('attendance.record') && !permissions.has('attendance.exempt');
}
