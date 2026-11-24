import { ctx } from '../../core/context/index.js';
import { formatBdt } from '../../core/money/index.js';
import type { I18n } from '../../core/module/types.js';
import { holdersOf } from '../rbac/index.js';
import { notify } from './service.js';

type P = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const t = (bn: string, en: string): I18n => ({ bn, en });

interface Rule {
  event: string;
  type: string;
  to: (p: P) => Promise<string[]> | string[];
  title: (p: P) => I18n;
  body: (p: P) => I18n;
  data?: (p: P) => Record<string, string>;
  /** The recipient is the requester (a decision about their own request). */
  keepActor?: boolean;
}

/** Recipients the emitting module already worked out (e.g. the request queues, ADR-066); never the actor. */
const listed = (p: P) => (Array.isArray(p.toUserIds) ? p.toUserIds.map(str) : []);

const managers = (permission: string) => async (p: P) => (str(p.branchId) ? holdersOf(permission, str(p.branchId)) : []);
/** Every holder of the permission in any branch: for records shared by all branches (map places, ADR-054). */
const allHolders = (permission: string) => async () => holdersOf(permission, null);

/** FR-NOT-002: which domain event tells whom what. Texts carry no phone numbers and no balances. */
const RULES: Rule[] = [
  {
    event: 'promise.due',
    type: 'promise.due',
    to: (p) => [str(p.ownerId)],
    title: () => t('আজ প্রতিশ্রুতির তারিখ', 'Promise due today'),
    body: (p) => t(`একজন গ্রাহক আজ ${formatBdt(Number(p.promisedAmountPoisha ?? 0), 'bn')} দেওয়ার কথা দিয়েছেন`, `A customer promised ${formatBdt(Number(p.promisedAmountPoisha ?? 0))} today`),
    data: (p) => ({ promiseId: str(p.promiseId), customerId: str(p.customerId) }),
  },
  {
    event: 'handover.created',
    type: 'handover.created',
    to: (p) => [str(p.toUserId)],
    title: () => t('নতুন হস্তান্তর', 'New handover'),
    body: () => t('আপনার জন্য গ্রাহক হস্তান্তর অপেক্ষা করছে। গ্রহণ বা প্রত্যাখ্যান করুন।', 'A customer handover is waiting for you. Accept or reject it.'),
    data: (p) => ({ handoverId: str(p.handoverId) }),
  },
  {
    event: 'handover.accepted',
    type: 'handover.decided',
    to: (p) => [str(p.fromUserId)],
    title: () => t('হস্তান্তর গৃহীত', 'Handover accepted'),
    body: () => t('আপনার গ্রাহক হস্তান্তর গ্রহণ করা হয়েছে।', 'Your customers were taken over.'),
    data: (p) => ({ handoverId: str(p.handoverId) }),
  },
  {
    event: 'handover.rejected',
    type: 'handover.decided',
    to: (p) => [str(p.createdBy)],
    title: () => t('হস্তান্তর প্রত্যাখ্যাত', 'Handover rejected'),
    body: () => t('প্রাপক হস্তান্তর প্রত্যাখ্যান করেছেন।', 'The receiver rejected the handover.'),
    data: (p) => ({ handoverId: str(p.handoverId) }),
  },
  {
    event: 'handover.expired',
    type: 'handover.decided',
    to: (p) => [str(p.createdBy)],
    title: () => t('হস্তান্তরের সময় শেষ', 'Handover expired'),
    body: () => t('৭২ ঘণ্টায় গ্রহণ না করায় হস্তান্তর বাতিল হয়েছে।', 'The handover was not accepted within 72 hours.'),
    data: (p) => ({ handoverId: str(p.handoverId) }),
  },
  {
    event: 'collection.conflict',
    type: 'collection.conflict',
    to: (p) => [str(p.collectorId)],
    title: () => t('আদায়ে সমস্যা', 'Collection needs attention'),
    body: (p) => t(`${formatBdt(Number(p.amountPoisha ?? 0), 'bn')} আদায়টি অফিসে যাচাইয়ের অপেক্ষায় আছে। টাকা নিরাপদে রেকর্ড আছে।`, `Your ${formatBdt(Number(p.amountPoisha ?? 0))} collection is waiting for office review. It is safely recorded.`),
    data: (p) => ({ collectionId: str(p.collectionId), code: str(p.code) }),
  },
  {
    event: 'collection.resolved',
    type: 'collection.resolved',
    to: (p) => [str(p.collectorId)],
    title: () => t('আদায়ের সমস্যা সমাধান', 'Collection resolved'),
    body: () => t('অফিস আপনার আদায়ের সমস্যাটি সমাধান করেছে।', 'The office resolved your collection.'),
    data: (p) => ({ collectionId: str(p.collectionId), action: str(p.action) }),
  },
  {
    event: 'cash.deposit.verified',
    type: 'cash.deposit.decided',
    to: (p) => [str(p.userId)],
    title: () => t('জমা যাচাই হয়েছে', 'Deposit verified'),
    body: () => t('আপনার জমা যাচাই করা হয়েছে।', 'Your deposit was verified.'),
    data: (p) => ({ depositId: str(p.depositId), decision: 'verified' }),
  },
  {
    event: 'cash.deposit.rejected',
    type: 'cash.deposit.decided',
    to: (p) => [str(p.userId)],
    title: () => t('জমা প্রত্যাখ্যাত', 'Deposit rejected'),
    body: () => t('আপনার জমা প্রত্যাখ্যান করা হয়েছে। বিস্তারিত দেখুন।', 'Your deposit was rejected. Open it for details.'),
    data: (p) => ({ depositId: str(p.depositId), decision: 'rejected' }),
  },
  {
    event: 'cash.deposit.deleted',
    type: 'cash.deposit.deleted',
    to: (p) => [str(p.userId)],
    title: () => t('জমা মুছে ফেলা হয়েছে', 'Deposit deleted'),
    body: (p) => t(`অফিস আপনার ${formatBdt(Number(p.amountPoisha ?? 0), 'bn')} জমা মুছে ফেলেছে। টাকা আবার আপনার হাতে নগদে যুক্ত হয়েছে।`, `The office deleted your ${formatBdt(Number(p.amountPoisha ?? 0))} deposit. The money is back in your cash on hand.`),
    data: (p) => ({ depositId: str(p.depositId), reason: str(p.reason) }),
  },
  {
    // Only when somebody else voided it: the collector's own withdraw needs no message.
    event: 'collection.voided',
    type: 'collection.voided',
    to: (p) => (str(p.byUserId) && str(p.byUserId) !== str(p.collectorId) ? [str(p.collectorId)] : []),
    title: () => t('আদায় বাতিল', 'Collection cancelled'),
    body: (p) => t(`অফিস আপনার ${formatBdt(Number(p.amountPoisha ?? 0), 'bn')} আদায় বাতিল করেছে।`, `The office cancelled your ${formatBdt(Number(p.amountPoisha ?? 0))} collection.`),
    data: (p) => ({ collectionId: str(p.collectionId), reason: str(p.reason) }),
  },
  {
    event: 'cash.limit_reached',
    type: 'cash.limit_reached',
    to: (p) => [str(p.userId)],
    title: () => t('হাতে নগদের সীমা', 'Cash on hand limit'),
    body: (p) => (p.state === 'exceeded' ? t('হাতে নগদ সীমা ছাড়িয়েছে। আগে জমা দিন।', 'Cash on hand is over the limit. Deposit first.') : t('হাতে নগদ সীমার কাছাকাছি। শীঘ্রই জমা দিন।', 'Cash on hand is close to the limit. Deposit soon.')),
    data: (p) => ({ state: str(p.state) }),
  },
  {
    event: 'tag.review_requested',
    type: 'tag.review',
    to: managers('tag.approve'),
    title: () => t('ট্যাগ পর্যালোচনা', 'Tag review'),
    body: (p) => (p.kind === 'balance_cleared' ? t('একজন ট্যাগ করা গ্রাহকের বকেয়া শূন্য হয়েছে। ট্যাগ রাখবেন কি না দেখুন।', 'A tagged customer has cleared the balance. Review the tag.') : t('একটি ট্যাগ অনুমোদনের অপেক্ষায় আছে।', 'A tag is waiting for approval.')),
    data: (p) => ({ customerId: str(p.customerId), eventId: str(p.eventId), kind: str(p.kind) }),
  },
  {
    event: 'tag.review_decided',
    type: 'tag.review',
    to: (p) => [str(p.requestedBy)],
    keepActor: true,
    title: () => t('ট্যাগের সিদ্ধান্ত', 'Tag decision'),
    body: (p) => (p.decision === 'approve' ? t('আপনার ট্যাগ অনুমোদিত হয়েছে।', 'Your tag was approved.') : t('আপনার ট্যাগ অনুমোদিত হয়নি।', 'Your tag was not approved.')),
    data: (p) => ({ customerId: str(p.customerId), decision: str(p.decision) }),
  },
  {
    event: 'customer.location.decided',
    type: 'location.proposal.decided',
    to: (p) => [str(p.proposedBy)],
    title: () => t('লোকেশন প্রস্তাবের সিদ্ধান্ত', 'Location proposal decision'),
    body: (p) => (p.decision === 'approve' ? t('আপনার দেওয়া লোকেশন অনুমোদিত হয়েছে।', 'Your location pin was approved.') : t('আপনার দেওয়া লোকেশন অনুমোদিত হয়নি।', 'Your location pin was not approved.')),
    data: (p) => ({ proposalId: str(p.proposalId), decision: str(p.decision) }),
  },
  {
    event: 'leave.requested',
    type: 'leave.requested',
    to: managers('attendance.manage'),
    title: () => t('ছুটির আবেদন', 'Leave request'),
    body: () => t('একটি ছুটির আবেদন অনুমোদনের অপেক্ষায় আছে।', 'A leave request is waiting for approval.'),
    data: (p) => ({ leaveId: str(p.leaveId) }),
  },
  {
    event: 'leave.decided',
    type: 'leave.decided',
    to: (p) => [str(p.userId)],
    title: () => t('ছুটির সিদ্ধান্ত', 'Leave decision'),
    body: (p) => (p.decision === 'approve' ? t('আপনার ছুটি অনুমোদিত হয়েছে।', 'Your leave was approved.') : t('আপনার ছুটি অনুমোদিত হয়নি।', 'Your leave was not approved.')),
    data: (p) => ({ leaveId: str(p.leaveId), decision: str(p.decision) }),
  },
  {
    event: 'attendance.auto_closed',
    type: 'attendance.auto_closed',
    to: (p) => [str(p.userId)],
    title: () => t('ডিউটি স্বয়ংক্রিয়ভাবে বন্ধ', 'Duty closed automatically'),
    body: () => t('আপনি ওয়ার্ক-আউট দেননি, তাই সিস্টেম দিনটি বন্ধ করেছে।', 'You did not work out, so the system closed your day.'),
    data: (p) => ({ businessDate: str(p.businessDate) }),
  },
  {
    event: 'cowork.requested',
    type: 'cowork.requested',
    to: (p) => (Array.isArray(p.toUserIds) ? p.toUserIds.map(str) : []),
    title: () => t('যৌথ কাজের অনুরোধ', 'Co-work request'),
    body: (p) => t(`${str(p.fromName)} আজ আপনার সাথে একসাথে কাজ করতে চান। গ্রহণ বা প্রত্যাখ্যান করুন।`, `${str(p.fromName)} wants to work together with you today. Accept or reject it.`),
    data: (p) => ({ sessionId: str(p.sessionId) }),
  },
  {
    event: 'cowork.responded',
    type: 'cowork.responded',
    to: (p) => [str(p.toUserId)],
    title: (p) => (p.decision === 'accept' ? t('যৌথ কাজের অনুরোধ গৃহীত', 'Co-work request accepted') : t('যৌথ কাজের অনুরোধ প্রত্যাখ্যাত', 'Co-work request rejected')),
    body: (p) => (p.decision === 'accept' ? t(`${str(p.name)} আপনার সাথে কাজ করতে রাজি হয়েছেন।`, `${str(p.name)} agreed to work with you.`) : t(`${str(p.name)} অনুরোধটি প্রত্যাখ্যান করেছেন।`, `${str(p.name)} rejected the request.`)),
    data: (p) => ({ sessionId: str(p.sessionId), decision: str(p.decision) }),
  },
  {
    // FR-CW-007: the person who asked withdrew the request (or ended their day) before these people answered.
    event: 'cowork.cancelled',
    type: 'cowork.cancelled',
    to: (p) => (Array.isArray(p.toUserIds) ? p.toUserIds.map(str) : []),
    title: () => t('যৌথ কাজের অনুরোধ বাতিল', 'Co-work request cancelled'),
    body: (p) => t(`${str(p.byName)} যৌথ কাজের অনুরোধটি বাতিল করেছেন। আর গ্রহণ করা যাবে না।`, `${str(p.byName)} cancelled the co-work request. It can no longer be accepted.`),
    data: (p) => ({ sessionId: str(p.sessionId) }),
  },
  {
    // FR-CW-006: the office ended the group; everyone who was in it or still invited is told.
    event: 'cowork.ended',
    type: 'cowork.ended',
    to: (p) => (Array.isArray(p.toUserIds) ? p.toUserIds.map(str) : []),
    title: () => t('যৌথ কাজ বন্ধ করা হয়েছে', 'Co-work ended by the office'),
    body: (p) => t(`অফিস আজকের যৌথ কাজ বন্ধ করেছে। কারণ: ${str(p.reason)}`, `The office ended today's co-work. Reason: ${str(p.reason)}`),
    data: (p) => ({ sessionId: str(p.sessionId), reason: str(p.reason) }),
  },
  {
    // 1.38.0 (FR-PLC-004): the office learns that a staff member wants a map place moved.
    // 1.42.0 (ADR-054): places belong to no branch, so every `place.manage` holder is told.
    event: 'place.move_requested',
    type: 'place.move_request',
    to: allHolders('place.manage'),
    title: () => t('জায়গা সরানোর অনুরোধ', 'Place move request'),
    body: (p) => t(`${str(p.requestedByName)} "${str(p.name)}" ম্যাপে সরাতে চান। অনুমোদন বা প্রত্যাখ্যান করুন।`, `${str(p.requestedByName)} wants to move "${str(p.name)}" on the map. Approve or reject it.`),
    data: (p) => ({ placeId: str(p.placeId) }),
  },
  {
    // FR-PLC-005: the requester learns the decision (and the reason of a rejection).
    event: 'place.move_decided',
    type: 'place.move_decided',
    to: (p) => [str(p.requestedBy)],
    keepActor: true,
    title: (p) => (p.decision === 'approve' ? t('জায়গা সরানো হয়েছে', 'Place moved') : t('জায়গা সরানো হয়নি', 'Place not moved')),
    body: (p) =>
      p.decision === 'approve'
        ? t(`"${str(p.name)}" আপনার দেওয়া জায়গায় সরানো হয়েছে।`, `"${str(p.name)}" was moved where you asked.`)
        : t(`"${str(p.name)}" সরানো হয়নি। কারণ: ${str(p.reason)}`, `"${str(p.name)}" was not moved. Reason: ${str(p.reason)}`),
    data: (p) => ({ placeId: str(p.placeId), decision: str(p.decision) }),
  },
  {
    event: 'task.assigned',
    type: 'task.assigned',
    to: (p) => [str(p.assigneeId)],
    title: () => t('নতুন কাজ দেওয়া হয়েছে', 'New task assigned'),
    body: (p) => t(str(p.title), str(p.title)),
    data: (p) => ({ taskId: str(p.taskId) }),
  },
  {
    event: 'task.resolve_requested',
    type: 'task.resolve_requested',
    to: managers('task.manage'),
    title: () => t('কাজ সমাধানের অনুরোধ', 'Task resolve request'),
    body: (p) => t(`${str(p.assigneeName)} "${str(p.title)}" কাজটি শেষ করেছেন। যাচাই করুন।`, `${str(p.assigneeName)} finished "${str(p.title)}". Please verify.`),
    data: (p) => ({ taskId: str(p.taskId) }),
  },
  {
    event: 'task.verified',
    type: 'task.decided',
    to: (p) => [str(p.assigneeId)],
    title: () => t('কাজ সমাধান হয়েছে', 'Task resolved'),
    body: (p) => t(`"${str(p.title)}" অফিস যাচাই করে সমাধান করেছে।`, `The office verified "${str(p.title)}".`),
    data: (p) => ({ taskId: str(p.taskId), decision: 'verified' }),
  },
  {
    event: 'task.rejected',
    type: 'task.decided',
    to: (p) => [str(p.assigneeId)],
    title: () => t('কাজটি আবার দেখুন', 'Task needs more work'),
    body: (p) => t(`"${str(p.title)}": ${str(p.note)}`, `"${str(p.title)}": ${str(p.note)}`),
    data: (p) => ({ taskId: str(p.taskId), decision: 'rejected' }),
  },
  {
    event: 'task.cancelled',
    type: 'task.decided',
    to: (p) => [str(p.assigneeId)],
    title: () => t('কাজ বাতিল', 'Task cancelled'),
    body: (p) => t(`"${str(p.title)}" কাজটি বাতিল করা হয়েছে।`, `"${str(p.title)}" was cancelled.`),
    data: (p) => ({ taskId: str(p.taskId), decision: 'cancelled' }),
  },
  // 1.48.0 requests / tickets (FR-REQ-005, ADR-066). The requests module names the recipients: the queue (super admin
  // or area managers, falling back to the super admins), the person it was forwarded or assigned to, or the creator.
  {
    event: 'request.created',
    type: 'request.important',
    to: (p) => (p.priority === 'important' ? listed(p) : []),
    title: () => t('জরুরি অনুরোধ', 'Important request'),
    body: (p) => t(`${str(p.byName)}: ${str(p.title)}`, `${str(p.byName)}: ${str(p.title)}`),
    data: (p) => ({ requestId: str(p.requestId) }),
  },
  {
    event: 'request.created',
    type: 'request.created',
    to: (p) => (p.priority === 'important' ? [] : listed(p)),
    title: () => t('নতুন অনুরোধ', 'New request'),
    body: (p) => t(`${str(p.byName)}: ${str(p.title)}`, `${str(p.byName)}: ${str(p.title)}`),
    data: (p) => ({ requestId: str(p.requestId) }),
  },
  {
    event: 'request.forwarded',
    type: 'request.forwarded',
    to: listed,
    title: () => t('অনুরোধ ফরোয়ার্ড করা হয়েছে', 'Request forwarded to you'),
    body: (p) => t(`${str(p.byName)}: "${str(p.title)}" — ${str(p.note)}`, `${str(p.byName)}: "${str(p.title)}" — ${str(p.note)}`),
    data: (p) => ({ requestId: str(p.requestId) }),
  },
  {
    event: 'request.assigned',
    type: 'request.assigned',
    to: listed,
    title: () => t('আপনাকে একটি অনুরোধ দেওয়া হয়েছে', 'Request assigned to you'),
    body: (p) => t(`${str(p.byName)}: "${str(p.title)}"`, `${str(p.byName)}: "${str(p.title)}"`),
    data: (p) => ({ requestId: str(p.requestId) }),
  },
  {
    event: 'request.commented',
    type: 'request.commented',
    to: listed,
    title: () => t('অনুরোধে নতুন মন্তব্য', 'New comment on a request'),
    body: (p) => t(`${str(p.byName)} "${str(p.title)}"-এ মন্তব্য করেছেন।`, `${str(p.byName)} commented on "${str(p.title)}".`),
    data: (p) => ({ requestId: str(p.requestId) }),
  },
  {
    event: 'request.resolved',
    type: 'request.resolved',
    to: listed,
    title: () => t('আপনার অনুরোধের সমাধান হয়েছে', 'Your request was resolved'),
    body: (p) => t(`"${str(p.title)}": ${str(p.note)}`, `"${str(p.title)}": ${str(p.note)}`),
    data: (p) => ({ requestId: str(p.requestId) }),
  },
  {
    event: 'request.reopened',
    type: 'request.reopened',
    to: listed,
    title: () => t('অনুরোধ আবার খোলা হয়েছে', 'Request reopened'),
    body: (p) => t(`${str(p.byName)}: "${str(p.title)}" — ${str(p.note)}`, `${str(p.byName)}: "${str(p.title)}" — ${str(p.note)}`),
    data: (p) => ({ requestId: str(p.requestId) }),
  },
  {
    event: 'request.closed',
    type: 'request.closed',
    to: listed,
    title: () => t('অনুরোধ বন্ধ করা হয়েছে', 'Request closed'),
    body: (p) => t(`"${str(p.title)}" বন্ধ করা হয়েছে।`, `"${str(p.title)}" was closed.`),
    data: (p) => ({ requestId: str(p.requestId) }),
  },
];

export const CONSUMED_EVENTS = [...new Set(RULES.map((r) => r.event))];

export function subscribe(): void {
  for (const r of RULES)
    ctx().bus.on(r.event, async (payload) => {
      const p = payload as P;
      // The actor never needs to be told about their own request.
      const to = (await r.to(p)).filter((id) => id && (r.keepActor || id !== str(p.requestedBy)));
      await notify({ userIds: to, type: r.type, title: r.title(p), body: r.body(p), ...(r.data ? { data: r.data(p) } : {}) });
    });
}
