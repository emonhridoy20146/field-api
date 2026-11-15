import { z } from 'zod';
import { defineRoutes, perm, requireUser } from '../../core/http/router.js';
import { parse } from '../../core/http/index.js';
import * as s from './service.js';

const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;
export const noteRoutes = defineRoutes((r) => {
  r.get('/customers/:id/notes', { access: perm('note.view') }, async (req) => s.listNotes(requireUser(req), idOf(req), parse(z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), cursor: z.string().max(200).optional() }), req.query)));
  r.post('/customers/:id/notes', { access: perm('note.create') }, async (req, reply) => {
    const res = await s.createNote(requireUser(req), idOf(req), parse(s.noteSchema, req.body));
    reply.code(res.statusCode);
    return res.body;
  });
  r.patch('/notes/:id', { access: perm('note.create') }, async (req) => s.editNote(requireUser(req), idOf(req), parse(z.object({ text: z.string().trim().min(1).max(2000) }), req.body).text));
  r.get('/customers/:id/contact-attempts', { access: perm('note.view') }, async (req) => s.listContacts(requireUser(req), idOf(req)));
  r.post('/customers/:id/contact-attempts', { access: perm('note.create') }, async (req, reply) => {
    const res = await s.logContact(requireUser(req), idOf(req), parse(s.contactSchema, req.body));
    reply.code(res.statusCode);
    return res.body;
  });
});
