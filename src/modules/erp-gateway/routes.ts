import { AppError } from '../../core/errors/index.js';
import { defineRoutes, perm } from '../../core/http/router.js';
import * as s from './service.js';

export const erpRoutes = defineRoutes((r) => {
  r.get('/system/erp-status', { access: perm('settings.manage') }, async () => s.status());
  // 1.13.0: pick the ERP employee a staff user collects as (the ERP requires one on every payment).
  r.get('/system/erp-employees', { access: perm('user.manage') }, async () => {
    try {
      const { items } = await s.listErpEmployees();
      return {
        items: items.map((e) => ({
          erpEmployeeId: e.erpEmployeeId,
          code: e.code,
          name: e.name,
          erpBranchIds: e.erpBranchIds,
          active: e.active,
        })),
      };
    } catch (e) {
      throw new AppError('ERP_UNAVAILABLE', { reason: e instanceof Error ? e.message.slice(0, 120) : 'unknown' });
    }
  });
});
