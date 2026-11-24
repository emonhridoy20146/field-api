import { describe, expect, it } from 'vitest';
import { checkAction, escapeRegex, levelFor, mayAct, queueAudience, statusAfter, STATUSES, type Action, type RequestStatus } from '../domain/rules.js';

describe('levelFor (FR-REQ-002)', () => {
  it('important goes to the super admin queue, normal to the area manager queue', () => {
    expect(levelFor('important')).toBe('super_admin');
    expect(levelFor('normal')).toBe('area_manager');
  });
});

describe('checkAction / statusAfter (FR-REQ-003)', () => {
  const open: RequestStatus[] = ['open', 'in_progress', 'forwarded', 'reopened'];
  it('forward, assign and resolve work on every open status and give forwarded / in_progress / resolved', () => {
    for (const s of open) {
      for (const a of ['forward', 'assign', 'resolve'] as const) expect(checkAction(a, s)).toEqual({ ok: true });
      expect(statusAfter('forward', s)).toBe('forwarded');
      expect(statusAfter('assign', s)).toBe('in_progress');
      expect(statusAfter('resolve', s)).toBe('resolved');
    }
  });
  it('a resolved or closed request cannot be moved or resolved again', () => {
    for (const a of ['forward', 'assign', 'resolve'] as const) {
      expect(checkAction(a, 'resolved')).toEqual({ ok: false, reason: 'REQUEST_RESOLVED' });
      expect(checkAction(a, 'closed')).toEqual({ ok: false, reason: 'REQUEST_CLOSED' });
    }
  });
  it('only a resolved or closed request reopens; it becomes reopened', () => {
    expect(checkAction('reopen', 'resolved')).toEqual({ ok: true });
    expect(checkAction('reopen', 'closed')).toEqual({ ok: true });
    for (const s of open) expect(checkAction('reopen', s)).toEqual({ ok: false, reason: 'REQUEST_OPEN' });
    expect(statusAfter('reopen', 'closed')).toBe('reopened');
  });
  it('close works from anything but closed; comments too, and keep the status', () => {
    for (const s of STATUSES) {
      const closed = s === 'closed';
      expect(checkAction('close', s).ok).toBe(!closed);
      expect(checkAction('comment', s).ok).toBe(!closed);
      expect(statusAfter('comment', s)).toBe(s);
    }
    expect(statusAfter('close', 'resolved')).toBe('closed');
  });
});

describe('mayAct (FR-REQ-004)', () => {
  const nobody = { manage: false, top: false, isCreator: false, isAssignee: false };
  const actions: Exclude<Action, 'comment'>[] = ['forward', 'assign', 'resolve', 'reopen', 'close'];
  it('area manager queue: request.manage or request.important.manage holders do everything', () => {
    for (const a of actions) {
      expect(mayAct(a, { ...nobody, manage: true }, 'area_manager')).toBe(true);
      expect(mayAct(a, { ...nobody, top: true }, 'area_manager')).toBe(true);
      expect(mayAct(a, nobody, 'area_manager')).toBe(false);
    }
  });
  it('super admin level: only request.important.manage moves, resolves or closes', () => {
    for (const a of actions) {
      expect(mayAct(a, { ...nobody, manage: true }, 'super_admin')).toBe(false);
      expect(mayAct(a, { ...nobody, top: true }, 'super_admin')).toBe(true);
    }
  });
  it('the assignee resolves what was given to them, at any level; never forwards or assigns', () => {
    for (const level of ['area_manager', 'super_admin'] as const) {
      expect(mayAct('resolve', { ...nobody, isAssignee: true }, level)).toBe(true);
      expect(mayAct('forward', { ...nobody, isAssignee: true }, level)).toBe(false);
      expect(mayAct('assign', { ...nobody, isAssignee: true }, level)).toBe(false);
    }
  });
  it('the creator reopens or withdraws (closes) their own, and cannot resolve it', () => {
    for (const level of ['area_manager', 'super_admin'] as const) {
      expect(mayAct('reopen', { ...nobody, isCreator: true }, level)).toBe(true);
      expect(mayAct('close', { ...nobody, isCreator: true }, level)).toBe(true);
      expect(mayAct('resolve', { ...nobody, isCreator: true }, level)).toBe(false);
    }
  });
});

describe('queueAudience (FR-REQ-005)', () => {
  it('super admin queue: the request.important.manage holders', () => {
    expect(queueAudience('super_admin', { manage: ['sa', 'am1'], top: ['sa', 'sa'] })).toEqual(['sa']);
  });
  it('area manager queue: request.manage holders who do not work the super admin queue', () => {
    expect(queueAudience('area_manager', { manage: ['sa', 'am1', 'am2'], top: ['sa'] })).toEqual(['am1', 'am2']);
  });
  it('falls back to the super admins when there is no area manager', () => {
    expect(queueAudience('area_manager', { manage: ['sa'], top: ['sa'] })).toEqual(['sa']);
    expect(queueAudience('area_manager', { manage: [], top: [] })).toEqual([]);
  });
});

describe('escapeRegex', () => {
  it('escapes regex metacharacters', () => {
    expect(escapeRegex('a.b*(c)')).toBe('a\\.b\\*\\(c\\)');
  });
});
