import { z } from 'zod';
import { ctx } from '../../core/context/index.js';
import { businessRule, invalidState, notFound } from '../../core/errors/index.js';
import { isOid, type LeanDoc } from '../../core/db/index.js';
import { recordChange } from '../../core/changefeed/index.js';
import { decodeCursor, encodeCursor } from '../../core/http/index.js';
import { businessDate, endOfBusinessDay } from '../../core/time/index.js';
import { branchQuery, type AuthUser } from '../../core/security/types.js';
import { getSetting } from '../settings/index.js';
import { getUsers } from '../users/index.js';
import { coWorkVisitCounts } from '../visits/index.js';
import { occupied, participantsAt, shouldEnd, visitCredit, type Member } from './domain/session.js';
import { CoworkSessionModel } from './models/cowork.model.js';

type Lean = LeanDoc;
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const requestSchema = z.object({ clientId: z.string().uuid(), toUserIds: z.array(z.string().max(64)).min(1).max(10), note: z.string().trim().max(300).optional() });
export const respondSchema = z.object({ decision: z.enum(['accept', 'reject']) });
export const listQuery = z.object({ branchId: z.string().max(64).optional(), userId: z.string().max(64).optional(), from: day.optional(), to: day.optional(), limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().max(200).optional() });

const iso = (d: unknown) => (d ? (d as Date).toISOString() : null);
const membersOf = (s: Lean): Member[] => (s.members ?? []) as Member[];
const idOf = (s: Lean): string => s._id.toHexString();
const nameOf = (u: AuthUser) => u.name.en || u.name.bn || '';

async function views(rows: Lean[], withVisits = false) {
  const users = await getUsers(rows.flatMap((s) => membersOf(s).map((m) => m.userId)));
  const counts = withVisits ? await coWorkVisitCounts(rows.map(idOf)) : null;
  return rows.map((s) => ({
    id: idOf(s),
    businessDate: s.businessDate as string,
    branchId: s.branchId as string,
    status: s.status as 'open' | 'ended',
    createdBy: s.createdBy as string,
    note: (s.note as string | null) ?? null,
    members: membersOf(s).map((m) => {
      const u = users.get(m.userId);
      return { userId: m.userId, name: u ? u.name.en || u.name.bn : '', status: m.status, invitedBy: m.invitedBy, invitedAt: iso(m.invitedAt)!, respondedAt: iso(m.respondedAt), leftAt: iso(m.leftAt) };
    }),
    createdAt: iso(s.createdAt)!,
    endedAt: iso(s.endedAt),
    ...(counts ? { visitsCount: counts.get(idOf(s)) ?? 0 } : {}),
  }));
}
const view = async (s: Lean, withVisits = false) => (await views([s], withVisits))[0]!;

/** Everyone invited or in the session learns about each change on their next pull (sync entity `cowork_session`). */
async function changed(s: Lean) {
  await recordChange({ entity: 'cowork_session', entityId: idOf(s), userIds: membersOf(s).map((m) => m.userId), branchId: s.branchId });
}

/** Persist the member list; close the session when the group has dissolved (FR-CW-002). */
async function save(s: Lean, members: Member[], at: Date): Promise<Lean> {
  const end = s.status === 'open' && shouldEnd(members);
  const next = (await CoworkSessionModel.findOneAndUpdate({ _id: s._id }, { $set: { members, ...(end ? { status: 'ended', endedAt: at } : {}) } }, { new: true }).lean()) as Lean;
  await changed(next);
  return next;
}

const openAccepted = (userId: string, date: string) => ({ status: 'open', businessDate: date, members: { $elemMatch: { userId, status: 'accepted' } } });

/** FR-CW-001. Idempotent by clientId; a second request by someone already working in a group adds to that group. */
export async function request(user: AuthUser, input: z.infer<typeof requestSchema>): Promise<{ statusCode: 200 | 201; body: Awaited<ReturnType<typeof view>> }> {
  const prior = (await CoworkSessionModel.findOne({ clientIds: input.clientId, 'members.userId': user.id }).lean()) as Lean | null;
  if (prior) return { statusCode: 200, body: await view(prior) };
  const branchId = user.branchIds[0];
  if (!branchId) throw businessRule('COWORK_INVALID_INVITEE');
  const toIds = [...new Set(input.toUserIds)];
  const found = await getUsers(toIds);
  for (const id of toIds) {
    const u = found.get(id);
    // The same answer for unknown, inactive, other-branch and non-field users: no probing of other branches.
    if (id === user.id || !u || !u.active || u.role !== 'field_staff' || !u.branchIds.includes(branchId)) throw businessRule('COWORK_INVALID_INVITEE', { userId: id });
  }
  const now = ctx().clock.now();
  const date = businessDate(now);
  const max = (await getSetting<number>('cowork.maxMembers', branchId)) ?? 5;
  const existing = (await CoworkSessionModel.findOne(openAccepted(user.id, date)).lean()) as Lean | null;
  const members: Member[] = existing ? membersOf(existing).map((m) => ({ ...m })) : [{ userId: user.id, status: 'accepted', invitedBy: user.id, invitedAt: now, respondedAt: now, leftAt: null }];
  const invited: string[] = [];
  for (const id of toIds) {
    const m = members.find((x) => x.userId === id);
    if (m && (m.status === 'accepted' || m.status === 'invited')) continue;
    // Someone who said no or left earlier can be asked again; their earlier time in the group stays in the visits already stored.
    if (m) Object.assign(m, { status: 'invited', invitedBy: user.id, invitedAt: now, respondedAt: null, leftAt: null });
    else members.push({ userId: id, status: 'invited', invitedBy: user.id, invitedAt: now, respondedAt: null, leftAt: null });
    invited.push(id);
  }
  if (occupied(members) > max) throw businessRule('COWORK_TOO_MANY', { max });
  let s: Lean;
  if (existing) {
    s = (await CoworkSessionModel.findOneAndUpdate({ _id: existing._id }, { $set: { members }, $addToSet: { clientIds: input.clientId } }, { new: true }).lean()) as Lean;
  } else {
    s = (await CoworkSessionModel.create({ branchId, businessDate: date, status: 'open', createdBy: user.id, note: input.note ?? null, members, clientIds: [input.clientId], createdAt: now })).toObject() as Lean;
  }
  await changed(s);
  if (invited.length) await ctx().bus.emit('cowork.requested', { sessionId: idOf(s), branchId, fromUserId: user.id, fromName: nameOf(user), toUserIds: invited });
  return { statusCode: 201, body: await view(s) };
}

async function ownSession(user: AuthUser, id: string): Promise<Lean> {
  if (!isOid(id)) throw notFound('cowork_session');
  const s = (await CoworkSessionModel.findOne({ _id: id, 'members.userId': user.id }).lean()) as Lean | null;
  if (!s) throw notFound('cowork_session');
  return s;
}

export async function respond(user: AuthUser, id: string, input: z.infer<typeof respondSchema>) {
  const s = await ownSession(user, id);
  const members = membersOf(s).map((m) => ({ ...m }));
  const me = members.find((m) => m.userId === user.id)!;
  const want = input.decision === 'accept' ? 'accepted' : 'rejected';
  if (me.status === want) return view(s); // replay
  if (s.status !== 'open') throw invalidState('SESSION_ENDED');
  if (me.status !== 'invited') throw invalidState('NOT_INVITED');
  const now = ctx().clock.now();
  if (want === 'accepted' && (await CoworkSessionModel.exists({ ...openAccepted(user.id, s.businessDate as string), _id: { $ne: s._id } }))) throw invalidState('ALREADY_IN_SESSION');
  me.status = want;
  me.respondedAt = now;
  const next = await save(s, members, now);
  await ctx().bus.emit('cowork.responded', { sessionId: id, branchId: s.branchId, userId: user.id, name: nameOf(user), decision: input.decision, toUserId: me.invitedBy });
  return view(next);
}

async function leaveAt(s: Lean, userId: string, at: Date): Promise<Lean> {
  const members = membersOf(s).map((m) => ({ ...m }));
  const me = members.find((m) => m.userId === userId);
  if (!me || s.status !== 'open') return s;
  if (me.status === 'accepted') Object.assign(me, { status: 'left', leftAt: at });
  else if (me.status === 'invited') Object.assign(me, { status: 'rejected', respondedAt: at });
  else return s;
  return save(s, members, at);
}

/** Idempotent: leaving twice, or leaving an ended session, returns the session as it is. */
export async function leave(user: AuthUser, id: string) {
  return view(await leaveAt(await ownSession(user, id), user.id, ctx().clock.now()));
}

/** FR-CW-002: the working day is over for this person, so they are no longer part of any group. */
export async function onWorkEnded(userId: string, at: Date): Promise<void> {
  const rows = (await CoworkSessionModel.find({ status: 'open', members: { $elemMatch: { userId, status: 'accepted' } } }).lean()) as Lean[];
  for (const s of rows) await leaveAt(s, userId, at);
}

/** FR-CW-002: a session never outlives its business day. Runs after Dhaka midnight. */
export async function endPastSessions(): Promise<number> {
  const today = businessDate(ctx().clock.now());
  const rows = (await CoworkSessionModel.find({ status: 'open', businessDate: { $lt: today } }).lean()) as Lean[];
  for (const s of rows) {
    const next = (await CoworkSessionModel.findOneAndUpdate({ _id: s._id }, { $set: { status: 'ended', endedAt: endOfBusinessDay(s.businessDate as string) } }, { new: true }).lean()) as Lean;
    await changed(next);
  }
  return rows.length;
}

export async function mine(user: AuthUser) {
  const rows = (await CoworkSessionModel.find({ businessDate: businessDate(ctx().clock.now()), 'members.userId': user.id }).sort({ _id: -1 }).lean()) as Lean[];
  return views(rows);
}

/** FR-CW-004. Branch scope; another branch's session does not exist for the caller. */
export async function list(user: AuthUser, q: z.infer<typeof listQuery>) {
  const f: Record<string, unknown> = { ...branchQuery(user, q.branchId) };
  if (q.userId) f['members.userId'] = q.userId;
  if (q.from || q.to) f.businessDate = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  const cur = decodeCursor<{ id: string }>(q.cursor);
  const rows = (await CoworkSessionModel.find({ ...f, ...(cur ? { _id: { $lt: cur.id } } : {}) }).sort({ _id: -1 }).limit(q.limit + 1).lean()) as Lean[];
  const items = rows.slice(0, q.limit);
  return { items: await views(items, true), nextCursor: rows.length > q.limit ? encodeCursor({ id: idOf(items[items.length - 1]!) }) : null };
}

export async function get(user: AuthUser, id: string) {
  if (!isOid(id)) throw notFound('cowork_session');
  const s = (await CoworkSessionModel.findOne({ _id: id, ...branchQuery(user, undefined) }).lean()) as Lean | null;
  if (!s) throw notFound('cowork_session');
  return view(s, true);
}

/** Sync loader: a session travels only to the people in it. */
export async function syncLoad(ids: string[], user: AuthUser): Promise<Map<string, Record<string, unknown>>> {
  const rows = (await CoworkSessionModel.find({ _id: { $in: ids.filter(isOid) }, 'members.userId': user.id }).lean()) as Lean[];
  return new Map((await views(rows)).map((v) => [v.id, v]));
}

/**
 * FR-CW-003: who took part in a visit the recorder made at `at`. `null` = the recorder was not an
 * accepted member then, so the visit is stored as a single visit with flag `cowork_invalid`.
 * Works for visits that sync hours later, because members keep their accept and leave times.
 */
export async function resolveParticipants(recorderId: string, sessionId: string, at: Date): Promise<string[] | null> {
  if (!isOid(sessionId)) return null;
  const s = (await CoworkSessionModel.findById(sessionId).lean()) as Lean | null;
  if (!s) return null;
  return participantsAt(membersOf(s), recorderId, at, (s.endedAt as Date | null) ?? endOfBusinessDay(s.businessDate as string));
}

/** FR-CW-005: the visit figure targets use, with the branch's weight for joint visits. */
export async function visitCreditFor(soloVisits: number, coWorkVisits: number, branchId?: string): Promise<number> {
  return visitCredit(soloVisits, coWorkVisits, (await getSetting<number>('cowork.visitCredit', branchId)) ?? 1);
}
