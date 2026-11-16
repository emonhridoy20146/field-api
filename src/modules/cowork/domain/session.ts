/** Pure co-work rules (FR-CW-001..005). No database, no clock. */

export type MemberStatus = 'invited' | 'accepted' | 'rejected' | 'left';

export interface Member {
  userId: string;
  status: MemberStatus;
  invitedBy: string;
  invitedAt: Date;
  /** When the member accepted or rejected; the requester "accepts" at creation. */
  respondedAt: Date | null;
  leftAt: Date | null;
}

/** Was this member part of the working group at this instant? */
export function activeAt(m: Member, at: Date): boolean {
  if (m.status !== 'accepted' && m.status !== 'left') return false;
  if (!m.respondedAt || m.respondedAt > at) return false;
  return !m.leftAt || m.leftAt > at;
}

/**
 * Who took part in a visit recorded by `recorderId` at `at`: the other members active at that
 * moment. `null` means the recorder was not an active member then (or the session was over),
 * so the visit must not be credited as co-work.
 */
export function participantsAt(members: Member[], recorderId: string, at: Date, sessionEnd: Date): string[] | null {
  if (at > sessionEnd) return null;
  const me = members.find((m) => m.userId === recorderId);
  if (!me || !activeAt(me, at)) return null;
  return members.filter((m) => m.userId !== recorderId && activeAt(m, at)).map((m) => m.userId);
}

/** A session is over once fewer than two people are working and nobody is still deciding (FR-CW-002). */
export function shouldEnd(members: Member[]): boolean {
  const accepted = members.filter((m) => m.status === 'accepted').length;
  const pending = members.filter((m) => m.status === 'invited').length;
  return accepted < 2 && pending === 0;
}

/** People who count towards the size limit: everyone still in or still invited. */
export function occupied(members: Member[]): number {
  return members.filter((m) => m.status === 'accepted' || m.status === 'invited').length;
}

/** FR-CW-005: the visit figure targets use. The weight is clamped to 0..1 so a bad setting cannot inflate credit. */
export function visitCredit(soloVisits: number, coWorkVisits: number, weight: number): number {
  const w = Number.isFinite(weight) ? Math.min(1, Math.max(0, weight)) : 1;
  return Math.round((soloVisits + coWorkVisits * w) * 100) / 100;
}
