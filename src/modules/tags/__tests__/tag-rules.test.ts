import { describe, expect, it } from 'vitest';
import { decide, effective, view, type Tag } from '../domain/tag-rules.js';

const at = new Date('2026-11-15T04:00:00Z');
const base = { actorId: 'u1', at, requireApproval: false, canApprove: false };
const tagged: Tag = { state: 'tagged', severity: 'bad', reasonCode: 'plan_ended_unpaid', reason: 'Plan ended, not paying', setBy: 'u0', setAt: at };

describe('tag rules', () => {
  it('requires a 10-char reason', () => {
    expect(decide(null, { state: 'tagged', reasonCode: 'absconded', reason: 'short' }, base)).toEqual({ ok: false, rule: 'REASON_TOO_SHORT' });
  });
  it('checks reason code direction', () => {
    expect(decide(null, { state: 'tagged', reasonCode: 'cleared', reason: 'balance is cleared now' }, base)).toMatchObject({ ok: false, rule: 'REASON_CODE_MISMATCH' });
    expect(decide(tagged, { state: 'none', reasonCode: 'absconded', reason: 'this is the reason' }, base)).toMatchObject({ ok: false, rule: 'REASON_CODE_MISMATCH' });
  });
  it('defaults severity to bad and applies directly without approval mode', () => {
    const d = decide(null, { state: 'tagged', reasonCode: 'absconded', reason: 'Left the village' }, base);
    expect(d).toMatchObject({ ok: true, mode: 'apply', next: { state: 'tagged', severity: 'bad', setBy: 'u1' } });
  });
  it('no-op changes are rejected; severity change is allowed', () => {
    expect(decide(tagged, { state: 'tagged', severity: 'bad', reasonCode: 'other', reason: 'same again same' }, base)).toMatchObject({ ok: false, rule: 'NO_CHANGE' });
    expect(decide(null, { state: 'none', reasonCode: 'mistake', reason: 'nothing to untag' }, base)).toMatchObject({ ok: false, rule: 'NO_CHANGE' });
    expect(decide(tagged, { state: 'tagged', severity: 'legal', reasonCode: 'other', reason: 'Sent to legal team' }, base)).toMatchObject({ ok: true });
  });
  it('approval mode: staff without tag.approve creates a request; approvers apply', () => {
    const r = { state: 'tagged' as const, reasonCode: 'refused_to_pay' as const, reason: 'Refused at the door' };
    expect(decide(null, r, { ...base, requireApproval: true })).toMatchObject({ ok: true, mode: 'request' });
    expect(decide(null, r, { ...base, requireApproval: true, canApprove: true })).toMatchObject({ ok: true, mode: 'apply' });
  });
  it('effective() reads through a pending overlay', () => {
    expect(effective({ state: 'none', pendingEventId: 'e1' }).state).toBe('none');
    expect(effective({ ...tagged, pendingEventId: 'e1' })).not.toHaveProperty('pendingEventId');
    expect(view({ state: 'none', pendingEventId: 'e1' })).toEqual({ state: 'pending' });
    expect(view({ ...tagged, pendingEventId: 'e1' })).toMatchObject({ state: 'tagged', severity: 'bad' });
  });
});
