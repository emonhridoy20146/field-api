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

const managers = (permission: string) => async (p: P) => (str(p.branchId) ? holdersOf(permission, str(p.branchId)) : []);

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
];

export const CONSUMED_EVENTS = RULES.map((r) => r.event);

export function subscribe(): void {
  for (const r of RULES)
    ctx().bus.on(r.event, async (payload) => {
      const p = payload as P;
      // The actor never needs to be told about their own request.
      const to = (await r.to(p)).filter((id) => id && (r.keepActor || id !== str(p.requestedBy)));
      await notify({ userIds: to, type: r.type, title: r.title(p), body: r.body(p), ...(r.data ? { data: r.data(p) } : {}) });
    });
}
