import { z } from 'zod';
import { defineRoutes, perm, requestMeta, requireUser } from '../../core/http/router.js';
import { parse } from '../../core/http/index.js';
import { listBranches, setLocation } from './service.js';

/** 1.13.0: the ERP has no branch coordinates, so admins set them in FOS (ADR-033). null clears. */
const locationBody = z.union([
  z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).strict(),
  z.object({ lat: z.null(), lng: z.null() }).strict(),
]);

export const branchRoutes = defineRoutes((r) => {
  r.get('/branches', { access: perm('branch.view') }, async (req) => listBranches(requireUser(req)));
  r.put('/branches/:id/location', { access: perm('settings.manage') }, async (req) =>
    setLocation(requireUser(req), (req.params as { id: string }).id, parse(locationBody, req.body), requestMeta(req)),
  );
});
