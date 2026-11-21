# 06 — Data Model (MongoDB Atlas, field-api)

Conventions
- `_id`: ObjectId unless noted. Client-created entities also carry `clientId` (UUIDv7) with a unique index for idempotent sync.
- All docs have `createdAt`, `updatedAt` (UTC Date), `version` (int, optimistic concurrency, incremented on each update), and `schemaVersion` (int, for migrations).
- Money: `…Poisha` integer fields. Never floats.
- Business dates: `businessDate: 'YYYY-MM-DD'` in Asia/Dhaka.
- `branchId` on every branch-scoped document (scope filter + index prefix).
- Soft delete only where noted (`deletedAt`); money and audit records are never deleted.
- Geo: GeoJSON `{ type: 'Point', coordinates: [lng, lat] }` with `2dsphere` index.
- Microfinance: reserved prefix `mf_`; no collections now.

## 1. Identity and access

### users
```json
{ "_id": "6734…", "name": { "bn": "রাকিব হাসান", "en": "Rakib Hasan" }, "phone": "+8801712345678",
  "username": "rakib.h", "passwordHash": "$argon2id$…", "mustChangePassword": false,
  "role": "field_staff", "branchIds": ["6731…"], "employeeCode": "FS014", "erpEmployeeId": "E-2231",
  "photoMediaId": null, "shiftId": "6735…", "cashLimitPoisha": 5000000, "active": true,
  "locale": "bn", "digits": "bn", "privacyNoticeAcceptedVersion": "2026-11-v1", "lastLoginAt": "…" }
```
Indexes: `{ phone: 1 } unique`, `{ username: 1 } unique sparse`, `{ employeeCode: 1 } unique`, `{ branchIds: 1, role: 1, active: 1 }`.

### sessions
`{ _id, userId, familyId, refreshTokenHash (sha256), deviceId, client: 'app'|'web', userAgent, ip, createdAt, lastUsedAt, expiresAt, revokedAt, revokedReason }`
Indexes: `{ refreshTokenHash: 1 } unique`, `{ userId: 1, revokedAt: 1 }`, TTL `{ expiresAt: 1 } expireAfterSeconds: 0`.

### login_attempts
`{ key: 'acct:+8801…'|'ip:1.2.3.4', at, success }` · TTL 1 day on `at`.

### permission_overrides
`{ _id, level: 'branch'|'user', branchId?, role?, userId?, key, effect: 'allow'|'deny', reason, setBy, setAt }`
Indexes: `{ level:1, userId:1, key:1 } unique partial(level='user')`, `{ level:1, branchId:1, role:1, key:1 } unique partial(level='branch')`.

### devices
`{ _id, deviceId (app install UUID), userId, model, manufacturer, androidVersion, appVersion, boundAt, unboundAt, lastSeenAt, rooted, emulator, fcmToken }`
Indexes: `{ deviceId: 1 } unique`, `{ userId: 1, unboundAt: 1 }`.

## 2. Reference data

### branches
`{ _id, erpBranchId, code: 'BRL01', kind: 'branch'|'warehouse' (1.13.0, default branch), name: {bn,en}, district, address, location: Point|null, active, dutyOverride?: {shiftId}, cashLimitDefaultPoisha, erpSyncedAt }` · `{ erpBranchId:1 } unique`, `{ code:1 } unique`. The ERP sends no coordinates; `location` is set in FOS (`PUT /branches/{id}/location`) and sync never clears it.

### settings
`{ _id, key: 'cash.limitMode', scope: 'global'|'branch', branchId?, value, type, updatedBy, updatedAt }` · `{ key:1, scope:1, branchId:1 } unique`.

### feature_flags
`{ _id: 'module.collections', defaultEnabled: false, branchOverrides: [{branchId, enabled}], description, owner, reviewBy, updatedBy, updatedAt }`.

### holidays · shifts
`holidays { date: 'YYYY-MM-DD', name {bn,en}, branchIds: [] (empty = all), type: 'national'|'branch', createdBy }` · index `{ date:1 }`. A `branch` holiday names its branches, a `national` one none; one day per overlapping set of branches (1.12.0). Deleting is a hard delete with an audit record (`holiday.deleted`) holding the old value.
`shifts { name, start: '09:00', end: '18:00', weeklyOff: [5] (0=Sun … 5=Fri; may be empty), lateGraceMin, maxBreakMin, breakWindows: [{ weekday, start, end }] (1.25.0) }`. The setting `attendance.defaultShift` has the same fields without `name`, org-wide or per branch. No migration: missing `breakWindows` reads as none.

## 3. ERP read model (cache, never truth)

### erp_customers
```json
{ "_id": "6740…", "erpCustomerId": "C-100245", "branchId": "6731…", "erpBranchId": "3",
  "code": "BRL01-100245", "name": { "bn": "মোঃ করিম উদ্দিন", "en": "Md Karim Uddin" },
  "phones": ["+8801811223344"], "address": "Vill: Charkawa, Barishal Sadar", "areaCode": "BSL-CHK",
  "erpLocation": { "lat": 22.7105, "lng": 90.3702 },
  "location": { "type": "Point", "coordinates": [90.3702, 22.7105] },
  "locationStatus": "ok",          
  "locationSource": "erp",          
  "plans": [
    { "erpPlanId": "P-55021", "product": "Walton Fridge WFC-3D8", "principalPoisha": 6500000,
      "downPaymentPoisha": 1000000, "installmentCount": 6, "startDate": "2026-05-10", "finalDueDate": "2026-10-10",
      "totalPayablePoisha": 6800000, "paidPoisha": 5950000, "outstandingPoisha": 850000, "status": "active",
      "schedule": [ { "seq": 1, "dueDate": "2026-06-10", "amountPoisha": 966700, "paidPoisha": 966700, "estimated": false } ] }
  ],
  "recentPayments": [ { "erpPaymentId": "PAY-9921", "date": "2026-09-12", "amountPoisha": 966700, "method": "cash", "source": "office", "receiptNo": "R-77812", "fieldCollectionId": null } ],
  "derived": { "totalOutstandingPoisha": 850000, "overdue": true, "daysOverdue": 36, "nextDueDate": null,
               "dueToday": false, "badSuggested": true, "badReason": { "erpPlanId": "P-55021", "finalDueDate": "2026-10-10", "outstandingPoisha": 850000 } },
  "erpStatus": "active", "erpUpdatedAt": "2026-11-14T10:22:00Z", "erpFetchedAt": "2026-11-15T00:55:00Z", "erpVersion": "…" }
```
`locationStatus`: `ok | missing | invalid | suspect_swapped | overridden`. `locationSource`: `erp | overlay`.
Since 1.13.0 (ADR-033, no migration: older documents simply lack the fields until their next sync):
- customer: `detailedAddress`, `directions` (ERP `location_instructions`), `erpRisk { grade, level, classification, overdueCount, maxDaysLate, computedAt }`.
- `plans[]` = one ERP invoice each: `kind` (`installment|credit`), `invoiceNo`, `erpInstallmentPlanId`, `erpBranchId`, `frequency`, `customDays`, `items[] { name, model, qty, serials[] }`, `guarantor { name, phone, phones[], address }`, `writtenOffPoisha`, `saleDate`; `status` `closed` = returned in the ERP. `schedule[]` gains `lateFeePoisha` (included in `amountPoisha`) and `rolled`.
- `recentPayments[]` gains `methodLabel`, `collectorName`, `collectorEmployeeId`, `advance`, `discountPoisha`; payments the office removed in the ERP are kept with `reversed: true, reversedAt`.
- `derived.plans[].lines[]` gains `lateFeePoisha`, `rolled`.
Since 1.14.0 (ADR-035): `derived.missedCount` (missed installments, `null` = derived before 1.14.0; migration `customers/20261118-0001-derive-missed-installments` and the nightly job fill it), `derived.plans[].missedCount`, `derived.plans[].lines[]` gains `paidOn`, `daysLate`, `missed`. Cached `plans[]` gain the invoice money (`subtotalPoisha`, `discountPoisha`, `taxPoisha`, `settlementDiscountPoisha`, `refundedPoisha`, `financedPoisha`), `invoiceStatus`, `paymentStatus`, `creditDueDate`, `penaltyEnabled`, `penaltyRate`; `items[]` gain `unitPricePoisha`, `discountPoisha`, `serviceChargePoisha`, `lineTotalPoisha`; `schedule[]` gains `payments[] { erpPaymentId, receiptNo, date, amountPoisha }` and `writtenOffPoisha`.
Indexes: `{ erpCustomerId:1 } unique`, `{ branchId:1, 'derived.overdue':1, 'derived.daysOverdue':-1 }`, `{ branchId:1, 'derived.dueToday':1 }`, `{ branchId:1, 'derived.badSuggested':1 }`, `{ location: '2dsphere' }`, `{ phones:1 }`, text/Atlas Search on `name.bn, name.en, code, phones`.
Derived fields are recomputed on each sync **and** nightly at 00:05 Dhaka (because dates move even when data does not).

### customer_overlays (FOS-owned per customer extras)
`{ _id: erpCustomerId-mapped ObjectId (= erp_customers._id), branchId, locationOverride?: {point, approvedBy, approvedAt, proposalId}, tag?: { state: 'none'|'pending'|'tagged', severity: 'watch'|'bad'|'legal', reasonCode, reason, setBy, setAt, eventId }, assigneeId (denormalized), areaId }` · `{ branchId:1, 'tag.state':1 }`, `{ assigneeId:1 }`.

1.23.0 (ADR-042): `extraPhones?: [{ number: '01XXXXXXXXX', label?, addedBy, addedByName, addedAt }]`, at most five, written only by `POST/DELETE /customers/{id}/phones`; the ERP sync never touches it. Optional with default `[]`, so no migration.

### location_proposals
`{ clientId, customerId, branchId, proposedBy, point, accuracyM, photoMediaId, note, method: gps|map, devicePoint?, deviceAccuracyM?, deviceMock, autoApplied, direct, status: pending|approved|rejected, decidedBy, decidedAt, decisionReason }`.
1.11.0 (ADR-031): `method`, `devicePoint`, `deviceAccuracyM`, `deviceMock`, `autoApplied` and `direct` added with defaults (`gps`, none, none, false, false, false), so older documents read unchanged and no migration is needed. A pin a manager sets on the map is a record with `direct: true`, `status: approved`, `proposedBy = decidedBy`. `locationOverride` on the customer gains `autoApplied` / `direct` flags. 1.17.0 (ADR-036): a deleted pin is `locationOverride: { cleared: true, clearedBy, clearedAt }` with `locationStatus: missing`, no `location`; the ERP sync honours it until a new pin replaces it.

### erp_sync_state
`{ _id: 'customers:branch:6731…', cursor, lastSuccessAt, lastErrorAt, lastError, consecutiveFailures, lagSec, resume? }`. 1.17.0: `resume: { cursor, since, serverTime }` is set while a budgeted pull (the manual sync) stopped mid-branch; the next run continues there and only then moves `cursor`. A second document `{ _id: 'manual-sync', lockedUntil }` is the lock of the "Sync from ERP" button. Both are optional (no migration).

## 4. Field operations

### tag_events (append-only)
`{ customerId, branchId, previous: {state,severity}, next: {state,severity}, reasonCode, reason, actorId, actorRole, source: 'web'|'app'|'system', deviceLocation?, at, approvalOf?: eventId }` · `{ customerId:1, at:-1 }`.

### areas
`{ branchId, name {bn,en}, code, kind: 'polygon'|'codes', polygon?: GeoJSON Polygon, erpAreaCodes?: [], color, active }` · `{ branchId:1, code:1 } unique`, `{ polygon: '2dsphere' }`.

### assignments
`{ _id, branchId, userId, type: 'area'|'customer', areaId?, customerId?, effectiveFrom, effectiveTo|null, source: 'manual'|'handover:<id>'|'bulk', createdBy }` · `{ userId:1, effectiveTo:1 }`, `{ customerId:1, effectiveTo:1 }`, `{ areaId:1, effectiveTo:1 }`.
Materialized: `assignment_scopes { _id: userId, customerIds: [...], recomputedAt }` (rebuilt on `assignment.changed`; ≤ 5,000 ids/user; above that switch to join query).

### handovers
`{ branchId, fromUserId, toUserId, areaIds, customerIds, reason, effectiveDate, endDate?, status, createdBy, decidedAt, decisionNote, summary: {customers, outstandingPoisha, overdue, openPromises, openConflicts}, expiresAt }` · `{ toUserId:1, status:1 }`, `{ fromUserId:1, createdAt:-1 }`.

### collections
```json
{ "_id": "6750…", "clientId": "0193a5e2-7c1f-7a3b-9e2d-4f6a8b1c2d3e", "idempotencyKey": "0193a5e2-7c1f-7a3b-9e2d-4f6a8b1c2d3e",
  "payloadHash": "sha256:…", "branchId": "6731…", "customerId": "6740…", "erpCustomerId": "C-100245", "erpPlanId": "P-55021",
  "collectorId": "6734…", "deviceId": "…", "amountPoisha": 500000, "method": "bkash", "transactionRef": "AB12CD34EF",
  "payerName": null, "note": "রবিবারে বাকি দিবে", "receiptNo": "BRL01-FS014-261115-0007", "physicalReceiptNo": null,
  "recordedAt": "2026-11-15T05:12:44Z", "deviceTime": "2026-11-15T05:12:40Z", "receivedAt": "2026-11-15T05:20:01Z",
  "businessDate": "2026-11-15", "geo": { "point": {"type":"Point","coordinates":[90.3705,22.7101]}, "accuracyM": 12, "mock": false, "distanceToPinM": 48 },
  "visitClientId": "0193a5e2-…", "photoMediaId": null,
  "status": "posted", "statusHistory": [ { "status": "received", "at": "…" }, { "status": "posting", "at": "…" }, { "status": "posted", "at": "…" } ],
  "erp": { "paymentId": "PAY-10233", "receiptNo": "R-78010", "postedAt": "…", "lastError": null, "attempts": 1, "reversed": false },
  "conflict": null, "flags": ["late_sync"], "voided": null, "resolution": null }
```
`conflict`: `{ code, message, erpResponse, raisedAt }`. `resolution`: `{ action, by, at, reason, proofMediaId, targetPlanId }`.
Indexes: `{ idempotencyKey:1 } unique`, `{ receiptNo:1 } unique`, `{ collectorId:1, businessDate:-1 }`, `{ branchId:1, businessDate:-1, status:1 }`, `{ customerId:1, recordedAt:-1 }`, `{ status:1, 'erp.attempts':1 }`, `{ method:1, transactionRef:1 } sparse`.
Retention: permanent (≥ 8 years, OD-09).

### receipt_blocks
`{ deviceId, userId, prefix: 'BRL01-FS014', businessDate, from: 1, to: 200, lastUsed }` — device asks for a block at sync; numbers are unique per `(prefix, YYMMDD, seq)`.

### idempotency_records
`{ _id: key, scope: 'collection'|'sync', payloadHash, response, entityId, createdAt }` · TTL 400 days on `createdAt` (collections themselves keep the key permanently).

### cash_deposits
`{ clientId, branchId, userId, amountPoisha, destination: 'branch_cashier'|'bank'|'manager', reference, slipMediaId, depositedAt, geo, status: 'pending'|'verified'|'rejected', verifiedBy, verifiedAt, rejectReason }` · `{ clientId:1 } unique`, `{ userId:1, status:1 }`, `{ branchId:1, status:1, depositedAt:-1 }`.

### cash_closings [ADDED]
`{ userId, businessDate, cashCollectedPoisha, mobileCollectedPoisha, depositedPoisha, onHandPoisha, confirmedAt, note }` · `{ userId:1, businessDate:1 } unique`.

### visits
`{ clientId, branchId, customerId, userId, checkInAt, checkOutAt, outcome, geo {point, accuracyM, mock, distanceToPinM}, photoMediaIds[], deviceTime, receivedAt, source: 'manual'|'suggested', stopId?, flags[], coWork: { sessionId, participantIds[] } | null }` · `{ clientId:1 } unique`, `{ customerId:1, checkInAt:-1 }`, `{ userId:1, checkInAt:-1 }`, `{ branchId:1, checkInAt:-1 }`, `{ 'coWork.sessionId':1 } sparse`, `{ 'coWork.participantIds':1, checkInAt:-1 } sparse`.
- `coWork` is set only when at least one colleague was an accepted member of the session at `checkInAt`; `participantIds` never contains the recorder (`userId`) (FR-CW-003).

### cowork_sessions
`{ branchId, businessDate, status: 'open'|'ended', createdBy, note, members: [{ userId, status: 'invited'|'accepted'|'rejected'|'left', invitedBy, invitedAt, respondedAt, leftAt }], clientIds[], createdAt, endedAt }` · `{ 'members.userId':1, businessDate:-1 }`, `{ branchId:1, businessDate:-1 }`, `{ status:1, businessDate:1 }`, `{ clientIds:1 }`.
- One document per group and business day. Members keep their accept and leave times, so the participants of any visit can be worked out later from `checkInAt` alone. `clientIds` holds the request ids that built the session (idempotent retries).

### staff_tasks [ADDED]
`{ branchId, assigneeId, createdBy, title, note | null, dueDate: 'YYYY-MM-DD' | null, status: 'open'|'resolve_requested'|'resolved'|'cancelled', resolveNote | null, resolveRequestedAt | null, decisionNote | null, decidedBy | null, decidedAt | null, events: [{ type: 'created'|'edited'|'resolve_requested'|'verified'|'rejected'|'cancelled', by, at, note | null }], clientId | null, createdAt, updatedAt }` · `{ assigneeId:1, status:1, _id:-1 }`, `{ branchId:1, status:1, _id:-1 }`, `{ status:1, dueDate:1 }`, `{ createdBy:1, clientId:1 } unique, partial on string clientId`.
- Free-form job for one field staff member, not tied to a customer (FR-TASK-001). `branchId` is one of the assignee's branches. `events` is the history shown in the drawer; a reject clears `resolveNote` / `resolveRequestedAt` (the event keeps them). Sync entity `task` goes only to `assigneeId`.

### notes
`{ clientId, branchId, customerId, authorId, category: 'general'|'payment'|'complaint'|'address'|'family', text, voiceMediaId?, visitClientId?, editableUntil, createdAt }` · `{ clientId:1 } unique`, `{ customerId:1, createdAt:-1 }`.

### contact_attempts
`{ clientId, branchId, customerId, userId, channel: 'call'|'sms'|'whatsapp', target: 'customer'|'guarantor' (1.12.0, default customer), phoneIndex | null, at, durationSec | null, outcome | null, note | null, receivedAt }` · `{ clientId:1 } unique`, `{ customerId:1, at:-1 }`. Phone numbers are never stored here (index into the customer's phones; the guarantor has one phone).

### promises
`{ clientId, branchId, customerId, erpPlanId, ownerId, createdBy, promisedDate, promisedAmountPoisha, note, status: 'open'|'kept'|'partially_kept'|'broken'|'superseded'|'cancelled', evaluatedAt, paidTowardsPoisha, supersededBy }` · `{ clientId:1 } unique`, `{ ownerId:1, promisedDate:1, status:1 }`, `{ customerId:1, status:1 }`, `{ branchId:1, promisedDate:1 }`.

### media
`{ _id, ownerId, kind: 'visit_photo'|'deposit_slip'|'selfie'|'location_proof'|'refund_proof'|'voice_note'|'export', bucketKey: 'media/2026/11/15/<uuid>.jpg', contentType, sizeBytes, sha256, width, height, capturedAt, geo, status: 'pending'|'confirmed', thumbKey }` · `{ sha256:1 }`, TTL on pending: `{ createdAt:1 } partial(status=pending) 1 day` (implemented by job since TTL partial filters on status are allowed).

### attendance_events
`{ clientId, userId, branchId, businessDate, type: 'work_in'|'break_start'|'break_end'|'work_out', at, deviceTime, receivedAt, geo|null, geoUnavailableReason, selfieMediaId?, source: 'app'|'correction'|'system', correction?: { by, reason, replacesEventId }, replacedBy?, flags[] }` · `{ clientId:1 } unique`, `{ userId:1, businessDate:1, at:1 }`. Append-only: a correction adds an event and marks the replaced one with `replacedBy`; the auto work-out is a `system` event.

### attendance_days
Derived, rebuildable from events. `{ userId, branchId, businessDate, status: 'not_started'|'on_duty'|'on_break'|'off_duty'|'present'|'late'|'absent'|'leave'|'holiday'|'weekly_off', state, firstIn, lastOut, lateMin, breakMin, overBreakMin, windowBreakMin (1.25.0), overtimeMin (1.25.0; absent on older days, which are derived again on read), breaks: [{start,end}], dutyMin, autoClosed, corrected, closed, flags[], shift: {start,end} }` · `{ userId:1, businessDate:1 } unique`, `{ branchId:1, businessDate:1 }`, `{ closed:1, state:1 }`.

### activity_items · activity_seen [ADDED 2026-11-21]
`activity_items { key (unique: 'collection:<id>', 'visit:<id>', 'promise:<id>', 'pin:<proposalId>'), type: 'collection'|'visit'|'promise'|'pin', branchId, actorId, customerId, entity, entityId, data { amountPoisha?, method?, outcome?, promisedDate?, applied?, flags? }, at }` · `{ key:1 } unique`, `{ branchId:1, _id:-1 }`, TTL `{ at:1 }` 45 days. Written only from domain events (FR-ACT-001). `activity_seen { userId (unique), at }`: until when each person has looked at the feed.

### leave_requests [ADDED]
`{ userId, branchId, type: 'casual'|'sick'|'other', from, to, reason, status: 'pending'|'approved'|'rejected'|'cancelled', decidedBy, decidedAt, decisionReason, cancelledAt, createdAt }` (`cancelled`/`cancelledAt` since 1.12.0; only the requester cancels, only while pending) · `{ userId:1, from:1 }`, `{ branchId:1, status:1, createdAt:-1 }`.

### staff_targets [ADDED]
`{ branchId, userId | null, kind: 'set'|'cleared', amountPoisha | null, visits | null, effectiveFrom: 'YYYY-MM-DD', reason, setBy, setAt }` · `{ userId:1, effectiveFrom:1 }`, `{ branchId:1, userId:1, effectiveFrom:1 }`.
- Append-only (ADR-030). `userId: null` is the branch default. The value for a person on a day is the latest personal record with `effectiveFrom ≤ day` (same day: later `setAt`), unless it is `cleared` or missing, in which case the latest branch default applies; no record means 0. `visits` may be fractional (co-work credit). Days that are not working days for the person (weekly off, holiday, approved leave) have no target. Planning values only: never money truth.

### storage_objects (driver `db` only, ADR-039)
`{ _id: <object key, e.g. selfie/<userId>/<sha256>.jpg>, contentType, sizeBytes, body: Binary, storedAt }`. Used only when the host has no S3 (Vercel test deployments); with S3 this collection stays empty. No extra index (lookups are by `_id`). Media ≤ 1 MB, exports below the 16 MB document limit.

## 5. Location

### location_points (time-series collection)
```js
db.createCollection('location_points', {
  timeseries: { timeField: 'recordedAt', metaField: 'meta', granularity: 'seconds' },
  expireAfterSeconds: 7776000   // 90 days, from setting location.retentionDays (migration updates via collMod)
});
```
Document: `{ recordedAt, meta: { userId, branchId, deviceId }, lat, lng, accuracyM, speedMps, headingDeg, altitudeM, activity: 'still'|'walking'|'on_bicycle'|'in_vehicle'|'unknown', battery: 0.64, charging, mock: false, receivedAt }`
Secondary index: `{ 'meta.userId': 1, recordedAt: 1 }`.

Since 1.22.0 a point may carry `lowAccuracy: true` (worse than `location.maxAccuracyM`): live marker only, excluded from route, stops and distance (ADR-041). `location_latest` has the same flag for its point.

### location_latest
`{ _id: userId, branchId, point, accuracyM, recordedAt, battery, activity, mock, heartbeatAt, gpsEnabled, permission, bgRestricted, appVersion, trackingProvider, trackingProviderFallback }` · `{ branchId:1 }`. The marker only moves forward in time; "on break" is read from attendance when the map is requested, not stored.

### location_heartbeats
`{ userId, at, battery, charging, gpsEnabled, permission: 'always'|'while_in_use'|'denied', bgRestricted, appVersion, pendingPoints, pendingMutations, trackingProvider, trackingProviderFallback }` · `{ userId:1, at:-1 }`, TTL 30 days on `at`.

### location_stops
Written by the nightly `location.summarize` job (re-runnable; replaces the day). `{ userId, branchId, businessDate, start, end, dwellMin, lat, lng, customerId?, customerName?, distanceToPinM?, visitId?, pointsCount }` · `{ userId:1, businessDate:1 }`, TTL 365 days on `end`.

### location_daily_summaries
`{ userId, branchId, businessDate, day, distanceKm, movingMin, stoppedMin, stopsCount, customerStops, firstPointAt, lastPointAt, gapsMin, mockPoints }` · `{ userId:1, businessDate:1 } unique` · TTL 730 days on `day`.

## 6. Notifications, inbox, sync, audit

- `notifications { userId, type, title {bn,en}, body {bn,en}, data, readAt, createdAt }` · `{ userId:1, createdAt:-1 }` · TTL 90 days.
- `push_tokens` → stored on `devices.fcmToken` (one per device).
- `broadcasts [ADDED] { title {bn,en}, body {bn,en}, branchIds[], roles[], requireAck, createdBy, createdAt, recipientIds[], ackedBy[], acks: [{userId, at}] }` · `{ recipientIds:1, _id:-1 }`. `ackedBy` is the membership list; `acks` (1.12.0) keeps when each recipient read it (the phone's tap time for offline reads, kept between sending and receipt). Broadcasts sent before 1.12.0 have no times.
- `inbox_items [ADDED] { key (dedupe, e.g. 'collection.conflict:6750…'), type, severity: 'low'|'medium'|'high'|'critical', branchId, entity, entityId, summary {bn,en}, status: 'open'|'snoozed'|'resolved', snoozedUntil, resolvedBy, resolvedAt, createdAt }` · `{ key:1 } unique`, `{ branchId:1, status:1, severity:-1, createdAt:-1 }`.
- `sync_changes { seq (int64 from counters), userIds: [] (audience), branchId, fanoutBranchId (1.19.0: also every device of this branch, ADR-038), entity, entityId, op: 'upsert'|'delete', at }` · `{ userIds:1, seq:1 }`, `{ fanoutBranchId:1, seq:1 }` · TTL 30 days (devices older than 30 days get a full resync: `410 CURSOR_EXPIRED`).
- `device_sync_state { deviceId, userId, branchId, lastPullSeq, lastPullAt, lastPushAt, pendingReported, lastError, appVersion }` · `{ deviceId:1, userId:1 } unique`, `{ branchId:1, lastPullAt:-1 }`.
- `counters { _id: 'sync_seq', value }`; resync floors `{ _id: 'sync_floor:<reason>', value }` (1.20.1, ADR-038 addendum: a pull cursor below the highest floor answers `410 CURSOR_EXPIRED`; `sync_floor:customers-branch-wide` is set at the first boot of 1.20.1 on a database with history, 0 on an empty one).
- `outbox`, `jobs` — see 04-architecture §6.5.
- `audit_logs { at, actorId, actorRole, action, entity, entityId, branchId, before, after, reason, ip, deviceId, requestId, prevHash, hash }` · `{ at:-1 }`, `{ entity:1, entityId:1, at:-1 }`, `{ actorId:1, at:-1 }`, `{ branchId:1, action:1, at:-1 }`. Mongo user for the API has **insert + find only** on this collection (custom role). Retention: money actions 8 years, others 3 years (job, OD-09).

## 7. Reports

- `overdue_snapshots { businessDate, branchId, buckets: {d1_30:{count,amountPoisha}, d31_60, d61_90, d90p}, totalOverdue: {count,amountPoisha}, badSuggested, tagged, takenAt }` · unique `{ businessDate:1, branchId:1 }` · retained 5 years. Written by `reports.overdue-snapshot` at 23:50 Dhaka; cached ERP values, never an official balance.
- `exports { requestedBy, type, format, params, locale, status: 'queued'|'running'|'ready'|'failed', storageKey, rows, error, createdAt, finishedAt, expiresAt }` · `{ status:1, createdAt:1 }`, TTL on `expiresAt` (7 days). The file is stored under `exports/<id>/…` in the private bucket.
- `daily_metrics` is **not created** (ADR-028): staff performance is aggregated from the source collections at request time. The planned shape, if volumes later need it: `{ businessDate, branchId, userId, visits, uniqueCustomers, collectionsCount, collectedPoisha: {…}, promisesDue, promisesKept, present, lateMin, breakMin, dutyMin, fieldMin, distanceKm }` · `{ businessDate:1, branchId:1, userId:1 } unique`.

## 8. Migrations
- Tool: `migrate-mongo`-style runner in `core/db/migrations` with changelog collection `migrations_changelog { id, module, appliedAt, checksum }`.
- File naming: `src/modules/<module>/migrations/20261115-0001-create-collections-indexes.ts` exporting `up(db)`; **no down** (forward-only), every migration idempotent (`createIndex` is safe; data migrations check `schemaVersion`).
- Index builds on large collections run in a rolling fashion via Atlas; migration logs duration.
- CI runs all migrations on an empty DB and on the latest staging snapshot (sanitized) before release.

## 9. Capacity estimate (100 staff)

| Collection | Growth | 1-year size (approx) |
|---|---|---|
| location_points | 120k/day, ~150 B compressed | ~5 GB raw over 90 days retained ≈ 1.6 GB on disk with TS compression |
| collections | 3k/day | ~1.1M docs, ~1.5 GB |
| visits | 4k/day | ~1.5M docs, ~1 GB |
| audit_logs | ~20k/day | ~7M docs, ~5 GB |
| erp_customers | 100k docs | ~1 GB |
Photos in object storage: ~1 GB/day → ~365 GB/year (lifecycle: move to infrequent access after 90 days; retention 3 years, OD-09).
Atlas M10 is enough for launch; plan M20 at > 60 staff or when working set > 2 GB.

## 10. Backup and restore
- Atlas cloud backup: snapshots every 6 h, retained 7 days; daily retained 30 days; weekly 12 weeks; monthly 12 months; continuous PITR 48 h (M10+).
- Object storage: bucket versioning ON, replication to second region/provider (proposed).
- **Monthly restore drill** (`scripts/restore-drill.sh` + runbook): restore latest snapshot to staging cluster, run `scripts/verify-restore.ts` (counts, latest collection timestamp, hash chain of audit log), record result in `docs/runbooks/restore-log.md`.
