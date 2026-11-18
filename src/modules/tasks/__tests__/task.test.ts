import { describe, expect, it } from 'vitest';
import { isClosed, isOverdue, transition } from '../domain/task.js';

describe('task life (FR-TASK-002..004)', () => {
  it('moves forward through request, verify and back through reject', () => {
    expect(transition('open', 'request_resolve')).toEqual({ to: 'resolve_requested', replay: false });
    expect(transition('resolve_requested', 'verify')).toEqual({ to: 'resolved', replay: false });
    expect(transition('resolve_requested', 'reject')).toEqual({ to: 'open', replay: false });
  });

  it('lets an admin cancel until the task is closed', () => {
    expect(transition('open', 'cancel')?.to).toBe('cancelled');
    expect(transition('resolve_requested', 'cancel')?.to).toBe('cancelled');
    expect(transition('resolved', 'cancel')).toBeNull();
  });

  it('treats a repeated request, verify or cancel as a replay so offline retries never fail', () => {
    expect(transition('resolve_requested', 'request_resolve')).toEqual({ to: 'resolve_requested', replay: true });
    expect(transition('resolved', 'verify')).toEqual({ to: 'resolved', replay: true });
    expect(transition('cancelled', 'cancel')).toEqual({ to: 'cancelled', replay: true });
  });

  it('refuses moves that skip a step or reopen a closed task', () => {
    expect(transition('open', 'verify')).toBeNull();
    expect(transition('open', 'reject')).toBeNull();
    expect(transition('resolved', 'request_resolve')).toBeNull();
    expect(transition('cancelled', 'request_resolve')).toBeNull();
    expect(transition('resolve_requested', 'edit')).toBeNull();
    expect(transition('open', 'edit')).toEqual({ to: 'open', replay: false });
  });

  it('is overdue only after the due date, and only while unfinished', () => {
    expect(isOverdue('open', '2026-11-17', '2026-11-18')).toBe(true);
    expect(isOverdue('open', '2026-11-18', '2026-11-18')).toBe(false);
    expect(isOverdue('resolved', '2026-11-01', '2026-11-18')).toBe(false);
    expect(isOverdue('open', null, '2026-11-18')).toBe(false);
    expect(isClosed('cancelled')).toBe(true);
    expect(isClosed('resolve_requested')).toBe(false);
  });
});
