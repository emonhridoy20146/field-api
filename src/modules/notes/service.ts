import { z } from 'zod';
import { ctx } from '../../core/context/index.js';
import { AppError, notFound } from '../../core/errors/index.js';
import { isDuplicateKey, isOid } from '../../core/db/index.js';
import { recordChange } from '../../core/changefeed/index.js';
import { decodeCursor, encodeCursor } from '../../core/http/index.js';
import type { AuthUser } from '../../core/security/types.js';
import { getUsers } from '../users/index.js';
import { getCustomerRef, type CustomerRef, type TimelineItem } from '../customers/index.js';
import { ContactAttemptModel, NoteModel } from './models/note.model.js';

type Lean = Record<string, any> & { _id: { toHexString(): string } };
const EDIT_WINDOW_MS = 15 * 60_000;

/** Notes are visible to everyone who can see the customer (FR-NOTE-001: "all in branch"). */
async function customerFor(user: AuthUser, id: string): Promise<CustomerRef> {
  const c = await getCustomerRef(user, id);
  if (!c?.branchId) throw notFound('customer');
  return c;
}

export const noteSchema = z.object({
  clientId: z.string().uuid(),
  text: z.string().trim().min(1).max(2000),
  category: z.enum(['general', 'payment', 'complaint', 'address', 'family']).default('general'),
  voiceMediaId: z.string().max(64).optional(),
  visitClientId: z.string().max(64).optional(),
});

async function noteViews(rows: Lean[]) {
  const users = await getUsers(rows.map((r) => r.authorId));
  return rows.map((n) => ({
    id: n._id.toHexString(),
    clientId: n.clientId,
    customerId: n.customerId,
    author: { id: n.authorId, name: users.get(n.authorId)?.name.en ?? '' },
    category: n.category,
    text: n.text,
    voiceMediaId: n.voiceMediaId ?? null,
    createdAt: (n.createdAt as Date).toISOString(),
    editableUntil: new Date((n.createdAt as Date).getTime() + EDIT_WINDOW_MS).toISOString(),
    ...(n.editedAt ? { editedAt: (n.editedAt as Date).toISOString() } : {}),
  }));
}

export async function createNote(user: AuthUser, customerId: string, input: z.infer<typeof noteSchema>) {
  const prior = (await NoteModel.findOne({ clientId: input.clientId }).lean()) as Lean | null;
  if (prior) {
    if (prior.authorId !== user.id) throw new AppError('IDEMPOTENCY_MISMATCH', { clientId: input.clientId });
    return { statusCode: 200 as const, body: (await noteViews([prior]))[0]! };
  }
  const c = await customerFor(user, customerId);
  try {
    const n = await NoteModel.create({ ...input, voiceMediaId: input.voiceMediaId ?? null, visitClientId: input.visitClientId ?? null, branchId: c.branchId, customerId: c.id, authorId: user.id, createdAt: ctx().clock.now() });
    const lean = n.toObject() as Lean;
    await recordChange({ entity: 'note', entityId: lean._id.toHexString(), userIds: c.assigneeId ? [...new Set([c.assigneeId, user.id])] : [user.id], branchId: c.branchId });
    await ctx().bus.emit('note.created', { noteId: lean._id.toHexString(), customerId: c.id, branchId: c.branchId, authorId: user.id });
    return { statusCode: 201 as const, body: (await noteViews([lean]))[0]! };
  } catch (e) {
    if (isDuplicateKey(e)) return createNote(user, customerId, input);
    throw e;
  }
}

/** Author may edit for 15 minutes; afterwards notes are immutable (add a new note instead). */
export async function editNote(user: AuthUser, id: string, text: string) {
  if (!isOid(id)) throw notFound('note');
  const n = (await NoteModel.findOne({ _id: id, authorId: user.id }).lean()) as Lean | null;
  if (!n) throw notFound('note');
  if (ctx().clock.now().getTime() > (n.createdAt as Date).getTime() + EDIT_WINDOW_MS) throw new AppError('INVALID_STATE', { reason: 'EDIT_WINDOW_CLOSED' });
  await NoteModel.updateOne({ _id: id }, { $set: { text, editedAt: ctx().clock.now() } });
  await recordChange({ entity: 'note', entityId: id, userIds: [user.id], branchId: n.branchId });
  return (await noteViews([(await NoteModel.findById(id).lean()) as Lean]))[0]!;
}

export async function listNotes(user: AuthUser, customerId: string, q: { limit: number; cursor?: string | undefined }) {
  const c = await customerFor(user, customerId);
  const cur = decodeCursor<{ id: string }>(q.cursor);
  const rows = (await NoteModel.find({ customerId: c.id, ...(cur ? { _id: { $lt: cur.id } } : {}) }).sort({ _id: -1 }).limit(q.limit + 1).lean()) as Lean[];
  const items = rows.slice(0, q.limit);
  return { items: await noteViews(items), nextCursor: rows.length > q.limit ? encodeCursor({ id: items[items.length - 1]!._id.toHexString() }) : null };
}

export async function recentNotes(customerId: string) {
  return noteViews((await NoteModel.find({ customerId }).sort({ _id: -1 }).limit(5).lean()) as Lean[]);
}

export async function getNote(user: AuthUser, id: string) {
  if (!isOid(id)) throw notFound('note');
  const n = (await NoteModel.findById(id).lean()) as Lean | null;
  if (!n || !(await getCustomerRef(user, n.customerId))) throw notFound('note');
  return (await noteViews([n]))[0]!;
}

// ---------------- contact attempts (FR-M-014, contract 1.2.0) ----------------

export const contactSchema = z.object({
  clientId: z.string().uuid(),
  customerId: z.string().max(64).optional(), // in the sync payload; the REST path carries it too
  channel: z.enum(['call', 'sms', 'whatsapp']),
  phoneIndex: z.number().int().min(0).max(9).optional(),
  at: z.string().datetime({ offset: true }),
  durationSec: z.number().int().min(0).max(36_000).nullable().optional(),
  outcome: z.enum(['connected', 'no_answer', 'busy', 'switched_off', 'wrong_number', 'sent']).optional(),
  note: z.string().max(300).optional(),
});

function contactView(a: Lean) {
  return {
    id: a._id.toHexString(),
    clientId: a.clientId,
    customerId: a.customerId,
    userId: a.userId,
    channel: a.channel,
    ...(a.phoneIndex !== null ? { phoneIndex: a.phoneIndex } : {}),
    at: (a.at as Date).toISOString(),
    durationSec: a.durationSec ?? null,
    ...(a.outcome ? { outcome: a.outcome } : {}),
    ...(a.note ? { note: a.note } : {}),
    receivedAt: (a.receivedAt as Date).toISOString(),
  };
}

export async function logContact(user: AuthUser, customerId: string, input: z.infer<typeof contactSchema>) {
  const prior = (await ContactAttemptModel.findOne({ clientId: input.clientId }).lean()) as Lean | null;
  if (prior) {
    if (prior.userId !== user.id) throw new AppError('IDEMPOTENCY_MISMATCH', { clientId: input.clientId });
    return { statusCode: 200 as const, body: contactView(prior) };
  }
  const c = await customerFor(user, customerId);
  try {
    const a = await ContactAttemptModel.create({
      clientId: input.clientId,
      branchId: c.branchId,
      customerId: c.id,
      userId: user.id,
      channel: input.channel,
      phoneIndex: input.phoneIndex ?? null,
      at: new Date(input.at),
      durationSec: input.durationSec ?? null,
      outcome: input.outcome ?? null,
      note: input.note ?? null,
      receivedAt: ctx().clock.now(),
    });
    const lean = a.toObject() as Lean;
    await recordChange({ entity: 'contact_attempt', entityId: lean._id.toHexString(), userIds: [user.id], branchId: c.branchId });
    return { statusCode: 201 as const, body: contactView(lean) };
  } catch (e) {
    if (isDuplicateKey(e)) return logContact(user, customerId, input);
    throw e;
  }
}

export async function listContacts(user: AuthUser, customerId: string) {
  const c = await customerFor(user, customerId);
  return ((await ContactAttemptModel.find({ customerId: c.id }).sort({ at: -1 }).limit(100).lean()) as Lean[]).map(contactView);
}

export async function getContact(user: AuthUser, id: string) {
  if (!isOid(id)) throw notFound('contact_attempt');
  const a = (await ContactAttemptModel.findById(id).lean()) as Lean | null;
  if (!a || !(await getCustomerRef(user, a.customerId))) throw notFound('contact_attempt');
  return contactView(a);
}

const CHANNEL_BN: Record<string, string> = { call: 'কল', sms: 'এসএমএস', whatsapp: 'হোয়াটসঅ্যাপ' };
export async function timelineItems(customerId: string, before: Date | null, limit: number): Promise<TimelineItem[]> {
  const notes = (await NoteModel.find({ customerId, ...(before ? { createdAt: { $lt: before } } : {}) }).sort({ createdAt: -1 }).limit(limit).lean()) as Lean[];
  const calls = (await ContactAttemptModel.find({ customerId, ...(before ? { at: { $lt: before } } : {}) }).sort({ at: -1 }).limit(limit).lean()) as Lean[];
  const users = await getUsers([...notes.map((n) => n.authorId), ...calls.map((c) => c.userId)]);
  const actor = (id: string) => (users.get(id) ? { actor: { id, name: users.get(id)!.name.en || users.get(id)!.name.bn } } : {});
  return [
    ...notes.map((n) => ({ kind: 'note', at: (n.createdAt as Date).toISOString(), ...actor(n.authorId), summary: { en: n.text.slice(0, 120), bn: n.text.slice(0, 120) }, refId: n._id.toHexString(), data: { category: n.category } })),
    ...calls.map((c) => ({ kind: 'contact_attempt', at: (c.at as Date).toISOString(), ...actor(c.userId), summary: { en: `${c.channel}${c.outcome ? `: ${c.outcome.replace(/_/g, ' ')}` : ''}`, bn: `${CHANNEL_BN[c.channel] ?? c.channel}${c.outcome ? `: ${c.outcome}` : ''}` }, refId: c._id.toHexString(), data: { durationSec: c.durationSec } })),
  ];
}
