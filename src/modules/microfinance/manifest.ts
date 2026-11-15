import type { ModuleManifest } from '../../core/module/types.js';

/**
 * RESERVED (FR-MF-001/002, ADR-020). No routes, no collections, no logic.
 * Microfinance is a separate business/legal entity regulated by MRA. Before ANY implementation:
 *  1. legal review (MRA licensing, data-subject separation) with a document reference,
 *  2. super admin sets settings `microfinance.legalApproved = true` (+ `microfinance.legalReference`),
 *  3. data goes into separate `mf_*` collections, preferably a separate database/cluster.
 * The flag cannot be enabled until (2) — enforced by the flags module (lockedReason).
 */
export const manifest: ModuleManifest = {
  name: 'microfinance',
  version: '0.0.0',
  description: 'Reserved boundary for the microfinance business — not implemented',
  featureFlag: {
    key: 'module.microfinance',
    default: false,
    description: 'Microfinance (reserved, blocked until legal approval)',
    owner: 'field-api',
    lockedReason: 'Requires legal (MRA) approval: set microfinance.legalApproved first (FR-MF-001)',
  },
  dependsOn: [],
  permissions: [
    { key: 'microfinance.view', description: { en: 'RESERVED — not grantable', bn: 'সংরক্ষিত' }, defaults: {}, reserved: true },
    { key: 'microfinance.manage', description: { en: 'RESERVED — not grantable', bn: 'সংরক্ষিত' }, defaults: {}, reserved: true },
  ],
  settings: [
    { key: 'microfinance.legalApproved', type: 'bool', default: false },
    { key: 'microfinance.legalReference', type: 'string', default: '' },
  ],
};
