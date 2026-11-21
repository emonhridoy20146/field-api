/** Pure rules of the staff activity feed (FR-ACT-001). No I/O. */

export const ACTIVITY_TYPES = ['collection', 'visit', 'promise', 'pin', 'collection_withdrawn', 'collection_edited', 'deposit_deleted'] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

type P = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const flags = (v: unknown): string[] => (Array.isArray(v) ? v.filter((f): f is string => typeof f === 'string') : []);

export interface ActivityDraft {
  /** Dedupe key: an event delivered twice must not show twice. */
  key: string;
  type: ActivityType;
  branchId: string | null;
  /** Who did it; null only when an older event does not say. For a deleted deposit: the staff member whose deposit it was. */
  actorId: string | null;
  /** 1.33.0: when somebody else did it to the actor's record (the office user who deleted the deposit). */
  byId?: string | null;
  customerId: string | null;
  entity: string;
  entityId: string;
  /** Small facts for the line, never free text and never a phone number. */
  data: { amountPoisha?: number; previousAmountPoisha?: number; method?: string; outcome?: string; promisedDate?: string; applied?: boolean; flags?: string[]; editCount?: number };
}

/**
 * Which domain events become a line of the feed, and what the line keeps. The owner's list: a collection taken, a
 * visit recorded, a promise made, a map pin set or proposed by staff.
 */
export const FROM_EVENT: Record<string, (p: P) => ActivityDraft | null> = {
  'collection.received': (p) => {
    const id = str(p.collectionId);
    if (!id) return null;
    const amount = num(p.amountPoisha);
    return {
      key: `collection:${id}`,
      type: 'collection',
      branchId: str(p.branchId) || null,
      actorId: str(p.collectorId) || null,
      customerId: str(p.customerId) || null,
      entity: 'collection',
      entityId: id,
      data: { ...(amount !== null ? { amountPoisha: amount } : {}), ...(str(p.method) ? { method: str(p.method) } : {}), ...(flags(p.flags).length ? { flags: flags(p.flags) } : {}) },
    };
  },
  'visit.recorded': (p) => {
    const id = str(p.visitId);
    if (!id) return null;
    return {
      key: `visit:${id}`,
      type: 'visit',
      branchId: str(p.branchId) || null,
      actorId: str(p.userId) || null,
      customerId: str(p.customerId) || null,
      entity: 'visit',
      entityId: id,
      data: { ...(str(p.outcome) ? { outcome: str(p.outcome) } : {}), ...(flags(p.flags).length ? { flags: flags(p.flags) } : {}) },
    };
  },
  'promise.created': (p) => {
    const id = str(p.promiseId);
    if (!id) return null;
    return {
      key: `promise:${id}`,
      type: 'promise',
      branchId: str(p.branchId) || null,
      actorId: str(p.ownerId) || null,
      customerId: str(p.customerId) || null,
      entity: 'promise',
      entityId: id,
      data: { ...(str(p.promisedDate) ? { promisedDate: str(p.promisedDate) } : {}) },
    };
  },
  // 1.33.0: the collector deleted their own cash collection before it was deposited (FR-COL-016).
  'collection.withdrawn': (p) => {
    const id = str(p.collectionId);
    if (!id) return null;
    const amount = num(p.amountPoisha);
    return {
      key: `collection_withdrawn:${id}`,
      type: 'collection_withdrawn',
      branchId: str(p.branchId) || null,
      actorId: str(p.collectorId) || str(p.byUserId) || null,
      customerId: str(p.customerId) || null,
      entity: 'collection',
      entityId: id,
      data: { ...(amount !== null ? { amountPoisha: amount } : {}), ...(str(p.method) ? { method: str(p.method) } : {}) },
    };
  },
  // 1.33.0: the collector corrected the amount, note or payer of their own cash collection. One line per edit.
  'collection.edited': (p) => {
    const id = str(p.collectionId);
    if (!id) return null;
    const amount = num(p.amountPoisha);
    const previous = num(p.previousAmountPoisha);
    const count = num(p.editCount);
    return {
      key: `collection_edited:${id}:${count ?? 1}`,
      type: 'collection_edited',
      branchId: str(p.branchId) || null,
      actorId: str(p.collectorId) || str(p.byUserId) || null,
      customerId: str(p.customerId) || null,
      entity: 'collection',
      entityId: id,
      data: { ...(amount !== null ? { amountPoisha: amount } : {}), ...(previous !== null ? { previousAmountPoisha: previous } : {}), ...(count !== null ? { editCount: count } : {}) },
    };
  },
  // 1.33.0: an office user deleted a staff member's cash deposit (FR-CASH-009). The line is about the staff member.
  'cash.deposit.deleted': (p) => {
    const id = str(p.depositId);
    if (!id) return null;
    const amount = num(p.amountPoisha);
    return {
      key: `deposit_deleted:${id}`,
      type: 'deposit_deleted',
      branchId: str(p.branchId) || null,
      actorId: str(p.userId) || null,
      byId: str(p.byUserId) || null,
      customerId: null,
      entity: 'deposit',
      entityId: id,
      data: amount !== null ? { amountPoisha: amount } : {},
    };
  },
  // A pin that waits for a manager.
  'customer.location.proposed': (p) => {
    const id = str(p.proposalId);
    if (!id) return null;
    return { key: `pin:${id}`, type: 'pin', branchId: str(p.branchId) || null, actorId: str(p.proposedBy) || null, customerId: str(p.customerId) || null, entity: 'customer', entityId: str(p.customerId) || id, data: { applied: false } };
  },
  // A staff pin that applied at once (the customer had none). A manager's own decision or direct pin is not staff activity.
  'customer.location.approved': (p) => {
    const id = str(p.proposalId);
    if (!id || p.autoApplied !== true) return null;
    return { key: `pin:${id}`, type: 'pin', branchId: str(p.branchId) || null, actorId: str(p.proposedBy) || null, customerId: str(p.customerId) || null, entity: 'customer', entityId: str(p.customerId) || id, data: { applied: true } };
  },
};

export const CONSUMED_EVENTS = Object.keys(FROM_EVENT);

/** Lines are kept this long (TTL index); the feed is for "what happened lately", the records themselves stay. */
export const RETENTION_DAYS = 45;
/** The badge stops counting here. */
export const UNSEEN_CAP = 99;
