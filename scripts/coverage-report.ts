/**
 * Read-only customer coverage report (1.44.0, owner report: the ERP has far more customers than the staff app shows).
 * Prints, from field-api's MongoDB only (it never calls the ERP and never writes):
 *   - customers stored in total, by ERP status, and without a FOS branch;
 *   - customers per branch (warehouses included) and the staff visibility setting of each branch;
 *   - how many customers each active field staff member can see (the same rule as customers.scopeFilter);
 *   - the ERP pull state per branch: last good run, an unfinished run (`resume`), the last error, rows skipped.
 * Usage: pnpm coverage:report   (reads MONGODB_URI / MONGODB_DB_NAME from .env)
 */
import mongoose from 'mongoose';
import { loadConfig } from '../src/core/config/index.js';
import { connectMongo, disconnectMongo } from '../src/core/db/index.js';

type Row = Record<string, unknown>;

const config = loadConfig();
await connectMongo(config.MONGODB_URI, config.MONGODB_DB_NAME);
const db = mongoose.connection;
const customers = db.collection('erp_customers');

const total = await customers.countDocuments();
const byStatus = await customers.aggregate<Row>([{ $group: { _id: '$erpStatus', n: { $sum: 1 } } }]).toArray();
const noBranch = await customers.countDocuments({ $or: [{ branchId: null }, { branchId: { $exists: false } }] });
console.log(`customers stored: ${total}`);
console.log(`by ERP status: ${byStatus.map((r) => `${String(r._id)}=${String(r.n)}`).join(', ')}`);
console.log(`without a FOS branch: ${noBranch}`);

const branches = await db.collection('branches').find().toArray();
const perBranch = new Map(
  (await customers.aggregate<Row>([{ $group: { _id: '$branchId', n: { $sum: 1 } } }]).toArray()).map((r) => [
    String(r._id),
    Number(r.n),
  ]),
);
const settings = await db.collection('settings').find({ key: 'customers.staffVisibility' }).toArray();
const globalVis = (settings.find((x) => x.scope === 'global')?.value as string | undefined) ?? 'branch';
const visOf = (branchId: string) =>
  (settings.find((x) => x.scope === 'branch' && x.branchId === branchId)?.value as string | undefined) ?? globalVis;
const users = await db
  .collection('users')
  .find({ active: { $ne: false } })
  .toArray();
const staffPer = (branchId: string) =>
  users.filter((u) => u.role === 'field_staff' && (u.branchIds as string[]).includes(branchId)).length;

console.log('\nper branch: id | code | kind | active | customers | staffVisibility | field staff');
for (const b of branches) {
  const id = b._id.toHexString();
  console.log(
    `${id} | ${String(b.code)} | ${String(b.kind ?? 'branch')} | ${String(b.active)} | ${perBranch.get(id) ?? 0} | ${visOf(id)} | ${staffPer(id)}`,
  );
}

console.log('\nfield staff: name | branches | customers they can see (whole branch or assigned only)');
for (const u of users.filter((x) => x.role === 'field_staff')) {
  const ids = u.branchIds as string[];
  const whole = ids.filter((b) => visOf(b) !== 'assigned');
  const assignedOnly = ids.filter((b) => visOf(b) === 'assigned');
  const filter: Row = {
    $or: [{ branchId: { $in: whole } }, { branchId: { $in: assignedOnly }, 'fos.assigneeId': u._id.toHexString() }],
  };
  const n = await customers.countDocuments(filter);
  const name = (u.name as { en?: string; bn?: string } | undefined)?.en ?? '';
  console.log(`${name} | ${ids.length} | ${n}`);
}

console.log(
  '\nERP pull state per ERP branch: id | last success | unfinished run | failures | last error | rows skipped',
);
for (const s of await db
  .collection('erp_sync_state')
  .find({ _id: { $regex: '^customers:branch:' } } as Row)
  .toArray()) {
  const skipped = Array.isArray(s.lastSkipped) ? s.lastSkipped.length : 0;
  console.log(
    `${String(s._id)} | ${s.lastSuccessAt ? (s.lastSuccessAt as Date).toISOString() : '-'} | ${s.resume ? 'yes' : 'no'} | ${String(s.consecutiveFailures ?? 0)} | ${String(s.lastError ?? '-').slice(0, 80)} | ${skipped}`,
  );
}
await disconnectMongo();
