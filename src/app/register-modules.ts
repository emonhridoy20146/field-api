/**
 * THE ONLY LIST OF MODULES (04-architecture §4). Add new modules here — nowhere else.
 * Order does not matter; the loader sorts by dependsOn.
 */
import type { ModuleManifest } from '../core/module/types.js';
import { manifest as audit } from '../modules/audit/manifest.js';
import { manifest as settings } from '../modules/settings/manifest.js';
import { manifest as flags } from '../modules/flags/manifest.js';
import { manifest as erpGateway } from '../modules/erp-gateway/manifest.js';
import { manifest as branches } from '../modules/branches/manifest.js';
import { manifest as users } from '../modules/users/manifest.js';
import { manifest as rbac } from '../modules/rbac/manifest.js';
import { manifest as auth } from '../modules/auth/manifest.js';
import { manifest as devices } from '../modules/devices/manifest.js';
import { manifest as system } from '../modules/system/manifest.js';
import { manifest as customers } from '../modules/customers/manifest.js';
import { manifest as tags } from '../modules/tags/manifest.js';
import { manifest as assignments } from '../modules/assignments/manifest.js';
import { manifest as handovers } from '../modules/handovers/manifest.js';
import { manifest as collections } from '../modules/collections/manifest.js';
import { manifest as cash } from '../modules/cash/manifest.js';
import { manifest as media } from '../modules/media/manifest.js';
import { manifest as visits } from '../modules/visits/manifest.js';
import { manifest as notes } from '../modules/notes/manifest.js';
import { manifest as promises } from '../modules/promises/manifest.js';
import { manifest as attendance } from '../modules/attendance/manifest.js';
import { manifest as sync } from '../modules/sync/manifest.js';
import { manifest as microfinance } from '../modules/microfinance/manifest.js';

export const manifests: ModuleManifest[] = [audit, settings, flags, erpGateway, branches, users, rbac, auth, devices, system, customers, tags, assignments, handovers, collections, cash, media, visits, notes, promises, attendance, sync, microfinance];
