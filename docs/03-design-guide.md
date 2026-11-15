# 03 — Design Guide (field-api)

field-api has no UI, but it shapes what users see: API naming, error and notification copy, formats, and the **shared design tokens** that both clients use. This guide keeps the three repos consistent.

## 1. API design rules
- Resources are plural nouns (`/customers`, `/collections`); actions that are not CRUD are sub-resources with verbs (`/handovers/{id}/accept`, `/collections/{id}/resolve`).
- JSON keys `camelCase`; enums `snake_case` strings; ids are strings.
- Money: `…Poisha` integers. Never send formatted money; clients format.
- Every list is paginated by cursor; every list has a stable default sort.
- Responses include what the screen needs in **one round trip** for the main screens (customer list item carries badges, open promise, last visit) — avoid N+1 calls on weak networks.
- Bilingual texts that the server produces are `{ "bn": "…", "en": "…" }` objects or localized via `Accept-Language`.
- Never expose internal Mongo field names that are not in the contract; mappers in each module's `schemas.ts` shape output.
- Never return data outside the caller's scope; out-of-scope = 404.

## 2. Copy and tone (notifications, errors)
- Bangla first, short, specific, actionable, no blame. Use the customer's name and amount.
- Pattern: **what happened → what to do**.

| Type | Bangla | English |
|---|---|---|
| Promise reminder | আজ করিম উদ্দিন ৳৩,৫০০ দেওয়ার কথা। | Karim Uddin promised ৳3,500 today. |
| Collection conflict | ৳৫,০০০ আদায়টি ইআরপি-তে পোস্ট হয়নি: প্ল্যান আগেই পরিশোধিত। ম্যানেজার দেখছেন। | ৳5,000 collection not posted: plan already settled. Your manager is reviewing. |
| Conflict resolved | আপনার ৳৫,০০০ আদায় নতুন প্ল্যানে জমা হয়েছে। | Your ৳5,000 collection was posted to the new plan. |
| Cash limit warning | হাতে নগদ ৳৪২,০০০ — সীমার ৮৪%। আজই জমা দিন। | Cash in hand ৳42,000 — 84% of limit. Please deposit today. |
| Handover pending | রাকিব আপনাকে ৩২ জন গ্রাহক হস্তান্তর করেছেন। গ্রহণ করুন বা ফেরত দিন। | Rakib handed over 32 customers to you. Accept or reject. |
| Deposit rejected | ৳২০,০০০ জমা বাতিল: স্লিপ পড়া যাচ্ছে না। আবার জমা দিন। | ৳20,000 deposit rejected: slip unreadable. Please resubmit. |
| Tag review | করিম উদ্দিনের বকেয়া শোধ হয়েছে — "খারাপ গ্রাহক" ট্যাগ পর্যালোচনা করুন। | Karim Uddin's balance is cleared — review the "bad customer" tag. |
| Error generic | কিছু একটা ভুল হয়েছে। আপনার তথ্য ফোনে সংরক্ষিত আছে, পরে আবার চেষ্টা হবে। | Something went wrong. Your data is saved on the phone and will retry. |

Terminology (use consistently in both apps):

| Concept | Bangla | English |
|---|---|---|
| Installment | কিস্তি | Installment |
| Collection | আদায় | Collection |
| Outstanding | বকেয়া | Outstanding |
| Overdue | মেয়াদোত্তীর্ণ / বকেয়া পড়েছে | Overdue |
| Due today | আজ দেয় | Due today |
| Promise to pay | প্রতিশ্রুতি | Promise |
| Visit | ভিজিট | Visit |
| Handover | হস্তান্তর | Handover |
| Cash in hand | হাতে নগদ | Cash in hand |
| Deposit | জমা | Deposit |
| Bad customer (suggested) | সম্ভাব্য খারাপ গ্রাহক | Suggested bad customer |
| Tagged | চিহ্নিত | Tagged |
| Pending in ERP | ইআরপি-তে অপেক্ষমাণ | Pending in ERP |
| Sync | সিঙ্ক | Sync |
| Work-in / Work-out | কাজ শুরু / কাজ শেষ | Work in / Work out |
| Break | বিরতি | Break |

## 3. Formats (server and clients must agree)
- Dates in UI: `১৫ নভেম্বর ২০২৬` (bn) / `15 Nov 2026` (en); times 12-hour with Bangla `সকাল/দুপুর/বিকাল/সন্ধ্যা/রাত` in bn, `11:12 AM` in en.
- Money: `৳১২,৫০,০০০` (bn digits, South-Asian grouping) / `৳12,50,000` (Latin digits). Decimals only if non-zero poisha.
- Phone: display `01712-345678`; store E.164.
- Receipt number: `BRL01-FS014-261115-0007` (monospace in UI).

## 4. Shared design tokens (v1.0)
The canonical token set is identical in `admin-web/docs/03-design-guide.md §2` and `staff-app/docs/03-design-guide.md §2`. field-api uses only the **status colour keys** (it returns status enums; clients map to colours). Any change to tokens must be made in both client docs in the same release and noted in both CHANGELOGs.

Status keys returned by the API → token names:

| API status | Token | Meaning |
|---|---|---|
| `overdue` | `status.overdue` | red |
| `due_today` | `status.dueToday` | amber |
| `promised_today` | `status.promised` | violet |
| `current` | `status.current` | blue |
| `paid_up` | `status.paid` | green |
| `bad_suggested` | `status.badSuggested` | orange outline |
| `tagged_bad` | `status.tagged` | deep red, filled |
| collection `posted` | `status.paid` | |
| collection `received`/`posting` | `status.pending` | grey-blue |
| collection `conflict`/`posting_failed` | `status.overdue` | |
