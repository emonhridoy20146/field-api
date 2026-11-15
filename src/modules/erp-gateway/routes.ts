import { defineRoutes, perm } from '../../core/http/router.js';
import * as s from './service.js';

export const erpRoutes = defineRoutes((r) => {
  r.get('/system/erp-status', { access: perm('settings.manage') }, async () => s.status());
});
