import { describe, expect, it } from 'vitest';
import { activeAt, occupied, participantsAt, shouldEnd, visitCredit, type Member } from '../domain/session.js';

const t = (hhmm: string) => new Date(`2026-11-15T${hhmm}:00Z`);
const m = (userId: string, status: Member['status'], respondedAt: string | null = null, leftAt: string | null = null): Member => ({ userId, status, invitedBy: 'a', invitedAt: t('03:00'), respondedAt: respondedAt ? t(respondedAt) : null, leftAt: leftAt ? t(leftAt) : null });
const END = t('17:59');

describe('co-work participants at a moment (FR-CW-003)', () => {
  const members = [m('a', 'accepted', '03:00'), m('b', 'accepted', '03:10'), m('c', 'left', '03:05', '04:00'), m('d', 'invited'), m('e', 'rejected', '03:06')];

  it('only members who had accepted and not yet left take part', () => {
    expect(participantsAt(members, 'a', t('03:07'), END)).toEqual(['c']); // b not yet in
    expect(participantsAt(members, 'a', t('03:30'), END)).toEqual(['b', 'c']);
    expect(participantsAt(members, 'a', t('04:00'), END)).toEqual(['b']); // c left exactly then
    expect(participantsAt(members, 'b', t('03:30'), END)).toEqual(['a', 'c']);
  });

  it('a recorder who was not active gets null, never a credited visit', () => {
    expect(participantsAt(members, 'b', t('03:09'), END)).toBeNull(); // before accepting
    expect(participantsAt(members, 'c', t('04:30'), END)).toBeNull(); // after leaving
    expect(participantsAt(members, 'd', t('03:30'), END)).toBeNull(); // only invited
    expect(participantsAt(members, 'e', t('03:30'), END)).toBeNull(); // rejected
    expect(participantsAt(members, 'z', t('03:30'), END)).toBeNull(); // stranger
    expect(participantsAt(members, 'a', t('18:30'), END)).toBeNull(); // session over
  });

  it('alone in the session means no participants (a single visit)', () => {
    expect(participantsAt([m('a', 'accepted', '03:00'), m('d', 'invited')], 'a', t('03:30'), END)).toEqual([]);
    expect(activeAt(m('x', 'accepted', null), t('03:30'))).toBe(false);
  });
});

describe('session life and credit', () => {
  it('ends when under two are working and nobody is still deciding', () => {
    expect(shouldEnd([m('a', 'accepted', '03:00'), m('b', 'invited')])).toBe(false);
    expect(shouldEnd([m('a', 'accepted', '03:00'), m('b', 'rejected', '03:05')])).toBe(true);
    expect(shouldEnd([m('a', 'accepted', '03:00'), m('b', 'accepted', '03:05')])).toBe(false);
    expect(shouldEnd([m('a', 'left', '03:00', '04:00'), m('b', 'accepted', '03:05')])).toBe(true);
    expect(shouldEnd([m('a', 'left', '03:00', '04:00'), m('b', 'accepted', '03:05'), m('c', 'invited')])).toBe(false);
    expect(occupied([m('a', 'accepted', '03:00'), m('b', 'invited'), m('c', 'rejected', '03:05'), m('d', 'left', '03:05', '03:20')])).toBe(2);
  });

  it('a co-work with nobody working is over, even with invitations unanswered (FR-CW-006)', () => {
    // the person who asked leaves before anyone answered: the request is cancelled
    expect(shouldEnd([m('a', 'left', '03:00', '03:10'), m('b', 'invited'), m('c', 'invited')])).toBe(true);
    // A and B working, C still deciding, A leaves: B can still be joined by C
    expect(shouldEnd([m('a', 'left', '03:00', '04:00'), m('b', 'accepted', '03:05'), m('c', 'invited')])).toBe(false);
    // A and B working, A leaves: one person is not a group
    expect(shouldEnd([m('a', 'left', '03:00', '04:00'), m('b', 'accepted', '03:05')])).toBe(true);
    // three working, one leaves: two are still a group
    expect(shouldEnd([m('a', 'left', '03:00', '04:00'), m('b', 'accepted', '03:05'), m('c', 'accepted', '03:06')])).toBe(false);
    // everybody gone
    expect(shouldEnd([m('a', 'left', '03:00', '04:00'), m('b', 'rejected', '03:05')])).toBe(true);
  });

  it('visit credit weights co-work visits and clamps the weight', () => {
    expect(visitCredit(4, 2, 1)).toBe(6);
    expect(visitCredit(4, 3, 0.5)).toBe(5.5);
    expect(visitCredit(4, 2, 0)).toBe(4);
    expect(visitCredit(4, 2, 7)).toBe(6);
    expect(visitCredit(4, 2, -1)).toBe(4);
    expect(visitCredit(4, 2, Number.NaN)).toBe(6);
  });
});
