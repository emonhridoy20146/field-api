import { Schema, model } from 'mongoose';
import { ctx } from '../../core/context/index.js';
import { isOid } from '../../core/db/index.js';
import { isSuperAdmin, type AuthUser } from '../../core/security/types.js';
import type { ErpBranch } from '../erp-gateway/index.js';

const branchSchema = new Schema(
  {
    erpBranchId: { type: String, required: true },
    code: { type: String, required: true },
    name: { bn: String, en: String },
    district: String,
    address: String,
    location: { type: { type: String, enum: ['Point'] }, coordinates: [Number] },
    active: { type: Boolean, default: true },
    // FOS-only extras (FR-BR-001)
    dutyOverride: { shiftId: String },
    cashLimitDefaultPoisha: { type: Number, default: null },
    erpSyncedAt: Date,
  },
  { collection: 'branches', versionKey: false, timestamps: true },
);
const BranchModel = model('Branch', branchSchema);

export interface BranchView {
  id: string;
  erpBranchId: string;
  code: string;
  name: { bn: string; en: string };
  district: string;
  address: string;
  lat: number | null;
  lng: number | null;
  active: boolean;
  cashLimitDefaultPoisha: number | null;
}

function view(b: { _id: { toHexString(): string }; erpBranchId: string; code: string; name?: { bn?: string | null; en?: string | null } | null; district?: string | null; address?: string | null; location?: { coordinates?: number[] } | null; active?: boolean | null; cashLimitDefaultPoisha?: number | null }): BranchView {
  const c = b.location?.coordinates;
  return {
    id: b._id.toHexString(),
    erpBranchId: b.erpBranchId,
    code: b.code,
    name: { bn: b.name?.bn ?? '', en: b.name?.en ?? '' },
    district: b.district ?? '',
    address: b.address ?? '',
    lat: c && c.length === 2 ? c[1]! : null,
    lng: c && c.length === 2 ? c[0]! : null,
    active: b.active ?? true,
    cashLimitDefaultPoisha: b.cashLimitDefaultPoisha ?? null,
  };
}

export async function upsertFromErp(branches: ErpBranch[]): Promise<void> {
  const now = ctx().clock.now();
  for (const b of branches) {
    await BranchModel.updateOne(
      { erpBranchId: b.erpBranchId },
      {
        $set: {
          code: b.code,
          name: b.name,
          district: b.district,
          address: b.address,
          active: b.active,
          erpSyncedAt: now,
          ...(b.lat !== null && b.lng !== null ? { location: { type: 'Point', coordinates: [b.lng, b.lat] } } : {}),
        },
      },
      { upsert: true },
    );
  }
  await ctx().bus.emit('branch.synced', { count: branches.length });
}

export async function listBranches(user?: AuthUser): Promise<BranchView[]> {
  const filter = user && !isSuperAdmin(user) ? { _id: { $in: user.branchIds.filter(isOid) } } : {};
  return (await BranchModel.find(filter).sort({ code: 1 }).lean()).map(view);
}

export async function getBranch(id: string): Promise<BranchView | null> {
  if (!isOid(id)) return null;
  const b = await BranchModel.findById(id).lean();
  return b ? view(b) : null;
}

export async function getByErpBranchId(erpBranchId: string): Promise<BranchView | null> {
  const b = await BranchModel.findOne({ erpBranchId }).lean();
  return b ? view(b) : null;
}

export async function getBranches(ids: string[]): Promise<Map<string, BranchView>> {
  const rows = await BranchModel.find({ _id: { $in: ids.filter(isOid) } }).lean();
  return new Map(rows.map((r) => [r._id.toHexString(), view(r)]));
}
