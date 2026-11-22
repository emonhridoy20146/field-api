import { ctx } from '../../core/context/index.js';
import type { I18n } from '../../core/module/types.js';
import { autoResolve, raise } from './service.js';

type P = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const t = (bn: string, en: string): I18n => ({ bn, en });
const DAY = 86_400_000;

interface Raise {
  event: string;
  type: string;
  when?: (p: P) => boolean;
  id: (p: P) => string;
  entity: string;
  summary: (p: P) => I18n;
  link: (p: P) => string;
  delayMs?: number;
  /** 1.42.0 (ADR-054): shown to every holder of this permission in any branch (shared records such as map places). */
  permission?: string;
}

/** FR-INB-001: events that open a "needs attention" item. Types and severities are declared by the owning modules. */
const RAISE: Raise[] = [
  { event: 'collection.conflict', type: 'collection.conflict', id: (p) => str(p.collectionId), entity: 'collection', summary: (p) => t(`আদায়ে সমস্যা: ${str(p.code)}`, `Collection conflict: ${str(p.code)}`), link: (p) => `/collections/${str(p.collectionId)}` },
  { event: 'collection.posting_failed', type: 'collection.posting_failed', id: (p) => str(p.collectionId), entity: 'collection', summary: () => t('আদায় ERP-তে পোস্ট করা যায়নি', 'Collection could not be posted to the ERP'), link: (p) => `/collections/${str(p.collectionId)}` },
  {
    event: 'collection.received',
    type: 'collection.flagged',
    when: (p) => Array.isArray(p.flags) && p.flags.length > 0,
    id: (p) => str(p.collectionId),
    entity: 'collection',
    summary: (p) => t(`সন্দেহজনক আদায়: ${(p.flags as string[]).join(', ')}`, `Flagged collection: ${(p.flags as string[]).join(', ')}`),
    link: (p) => `/collections/${str(p.collectionId)}`,
  },
  { event: 'cash.limit_reached', type: 'cash.over_limit', when: (p) => p.state === 'exceeded', id: (p) => str(p.userId), entity: 'user', summary: () => t('হাতে নগদ সীমা ছাড়িয়েছে', 'Cash on hand is over the limit'), link: (p) => `/cash?userId=${str(p.userId)}` },
  { event: 'cash.deposit.recorded', type: 'cash.deposit.pending', id: (p) => str(p.depositId), entity: 'deposit', summary: () => t('জমা ২৪ ঘণ্টার বেশি যাচাই হয়নি', 'Deposit unverified for more than 24 hours'), link: () => '/cash/deposits?status=pending', delayMs: DAY },
  { event: 'handover.unaccepted', type: 'handover.unaccepted', id: (p) => str(p.handoverId), entity: 'handover', summary: () => t('হস্তান্তর ২৪ ঘণ্টায় গৃহীত হয়নি', 'Handover not accepted within 24 hours'), link: (p) => `/handovers/${str(p.handoverId)}` },
  { event: 'tag.review_requested', type: 'tag.review', id: (p) => str(p.eventId), entity: 'customer', summary: (p) => (p.kind === 'balance_cleared' ? t('ট্যাগ করা গ্রাহকের বকেয়া শূন্য', 'Tagged customer cleared the balance') : t('ট্যাগ অনুমোদনের অপেক্ষায়', 'Tag waiting for approval')), link: () => '/tags/review-queue' },
  { event: 'customer.location.proposed', type: 'location.proposal', id: (p) => str(p.proposalId), entity: 'customer', summary: () => t('লোকেশন প্রস্তাব অনুমোদনের অপেক্ষায়', 'Location proposal waiting for approval'), link: () => '/location-proposals' },
  { event: 'promise.broken', type: 'promise.broken', id: (p) => str(p.promiseId), entity: 'promise', summary: () => t('প্রতিশ্রুতি রক্ষা হয়নি', 'Promise broken'), link: (p) => `/customers/${str(p.customerId)}` },
  { event: 'attendance.absent', type: 'attendance.absent', id: (p) => `${str(p.userId)}:${str(p.businessDate)}`, entity: 'user', summary: (p) => t(`${str(p.businessDate)} তারিখে অনুপস্থিত`, `Absent on ${str(p.businessDate)}`), link: (p) => `/attendance?userId=${str(p.userId)}` },
  { event: 'location.mock_detected', type: 'location.mock', id: (p) => `${str(p.userId)}:${str(p.businessDate)}`, entity: 'user', summary: (p) => t(`${str(p.businessDate)} তারিখে নকল GPS ধরা পড়েছে`, `Mock GPS detected on ${str(p.businessDate)}`), link: (p) => `/location/history?userId=${str(p.userId)}&date=${str(p.businessDate)}` },
  { event: 'location.tracking_lost', type: 'location.tracking_lost', id: (p) => `${str(p.userId)}:${str(p.businessDate)}`, entity: 'user', summary: () => t('ডিউটিতে থাকা অবস্থায় ট্র্যাকিং বন্ধ', 'Tracking stopped while on duty'), link: (p) => `/location/latest?userId=${str(p.userId)}` },
  { event: 'leave.requested', type: 'leave.requested', id: (p) => str(p.leaveId), entity: 'leave_request', summary: () => t('ছুটির আবেদন অপেক্ষমাণ', 'Leave request pending'), link: () => '/leave-requests?status=pending' },
  // 1.38.0 (FR-PLC-004): a staff member asked to move a map place; one item per request, closed by the decision.
  // 1.42.0 (ADR-054): places belong to no branch, so the item goes to every `place.manage` holder.
  { event: 'place.move_requested', type: 'place.move_request', permission: 'place.manage', id: (p) => `${str(p.placeId)}:${str(p.requestClientId)}`, entity: 'place', summary: (p) => t(`জায়গা সরানোর অনুরোধ: ${str(p.name)}`, `Place move request: ${str(p.name)}`), link: () => '/places/move-requests' },
  { event: 'task.resolve_requested', type: 'task.resolve_requested', id: (p) => str(p.taskId), entity: 'task', summary: (p) => t(`কাজ যাচাইয়ের অপেক্ষায়: ${str(p.title)}`, `Task waiting for verification: ${str(p.title)}`), link: () => '/tasks?status=resolve_requested' },
];

/** Events that close an item without a human: [event, item type, id from payload]. */
const RESOLVE: [string, string, (p: P) => string][] = [
  ['collection.resolved', 'collection.conflict', (p) => str(p.collectionId)],
  ['collection.voided', 'collection.conflict', (p) => str(p.collectionId)],
  ['collection.resolved', 'collection.posting_failed', (p) => str(p.collectionId)],
  ['collection.voided', 'collection.posting_failed', (p) => str(p.collectionId)],
  ['collection.posted', 'collection.posting_failed', (p) => str(p.collectionId)],
  ['collection.posted', 'collection.conflict', (p) => str(p.collectionId)],
  ['cash.deposit.verified', 'cash.deposit.pending', (p) => str(p.depositId)],
  ['cash.deposit.rejected', 'cash.deposit.pending', (p) => str(p.depositId)],
  ['cash.deposit.deleted', 'cash.deposit.pending', (p) => str(p.depositId)],
  ['collection.withdrawn', 'collection.conflict', (p) => str(p.collectionId)],
  ['collection.withdrawn', 'collection.posting_failed', (p) => str(p.collectionId)],
  ['cash.deposit.verified', 'cash.over_limit', (p) => str(p.userId)],
  ['handover.accepted', 'handover.unaccepted', (p) => str(p.handoverId)],
  ['handover.rejected', 'handover.unaccepted', (p) => str(p.handoverId)],
  ['handover.expired', 'handover.unaccepted', (p) => str(p.handoverId)],
  ['handover.cancelled', 'handover.unaccepted', (p) => str(p.handoverId)],
  ['tag.review_decided', 'tag.review', (p) => str(p.eventId)],
  ['customer.location.decided', 'location.proposal', (p) => str(p.proposalId)],
  ['leave.decided', 'leave.requested', (p) => str(p.leaveId)],
  ['leave.cancelled', 'leave.requested', (p) => str(p.leaveId)],
  ['task.verified', 'task.resolve_requested', (p) => str(p.taskId)],
  ['task.rejected', 'task.resolve_requested', (p) => str(p.taskId)],
  ['task.cancelled', 'task.resolve_requested', (p) => str(p.taskId)],
  ['place.move_decided', 'place.move_request', (p) => `${str(p.placeId)}:${str(p.requestClientId)}`],
];

export const CONSUMED_EVENTS = [...new Set([...RAISE.map((r) => r.event), ...RESOLVE.map((r) => r[0])])];

export function subscribe(): void {
  const bus = ctx().bus;
  for (const r of RAISE)
    bus.on(r.event, async (payload) => {
      const p = payload as P;
      if (r.when && !r.when(p)) return;
      const id = r.id(p);
      if (!id) return;
      await raise({ key: `${r.type}:${id}`, type: r.type, branchId: str(p.branchId) || null, entity: r.entity, entityId: id, summary: r.summary(p), link: r.link(p), ...(r.delayMs ? { delayMs: r.delayMs } : {}), ...(r.permission ? { permission: r.permission } : {}) });
    });
  for (const [event, type, id] of RESOLVE) bus.on(event, async (payload) => autoResolve(`${type}:${id(payload as P)}`));
}
