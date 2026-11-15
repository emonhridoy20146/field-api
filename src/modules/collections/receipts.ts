import { z } from 'zod';
import { nextSeq } from '../../core/changefeed/index.js';
import { businessRule, notFound } from '../../core/errors/index.js';
import { isIsoDate, yymmdd } from '../../core/time/index.js';
import type { AuthUser } from '../../core/security/types.js';
import { getBranch } from '../branches/index.js';
import { getUser } from '../users/index.js';
import { Schema, model } from 'mongoose';
import { ctx } from '../../core/context/index.js';

const blockSchema = new Schema(
  { deviceId: String, userId: String, prefix: String, businessDate: String, from: Number, to: Number, createdAt: Date },
  { collection: 'receipt_blocks', versionKey: false },
);
const ReceiptBlockModel = model('ReceiptBlock', blockSchema);

export const blockSchemaIn = z.object({ deviceId: z.string().min(1).max(128), businessDate: z.string().refine(isIsoDate, 'YYYY-MM-DD'), size: z.number().int().min(10).max(1000).default(200) });

/**
 * FR-COL-002: the device gets a range of sequence numbers for (prefix, date) so receipts stay unique offline.
 * The counter is global per prefix+date, so two devices of one staff never overlap.
 */
export async function allocateBlock(user: AuthUser, input: z.infer<typeof blockSchemaIn>) {
  const u = await getUser(user.id);
  const branch = u?.branchIds[0] ? await getBranch(u.branchIds[0]) : null;
  if (!u || !branch) throw notFound('branch');
  const prefix = `${branch.code}-${u.employeeCode}`.toUpperCase();
  const counter = `receipt:${prefix}:${yymmdd(input.businessDate)}`;
  const to = await nextSeq(counter, undefined, input.size);
  const from = to - input.size + 1;
  if (to > 9999) throw businessRule('RECEIPT_SEQUENCE_EXHAUSTED'); // SEQ4 is per staff per day
  await ReceiptBlockModel.create({ deviceId: input.deviceId, userId: user.id, prefix, businessDate: input.businessDate, from, to, createdAt: ctx().clock.now() });
  return { prefix, businessDate: input.businessDate, from, to };
}
