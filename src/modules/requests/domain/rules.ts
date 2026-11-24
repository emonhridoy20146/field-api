/**
 * Requests / tickets (FR-REQ-001..006, ADR-066): pure rules. No I/O, no clock: the service passes `now` in.
 * A request lives at a level (the queue responsible for it: area manager or super admin) and waits either in that
 * queue or with a person (assignee). The timeline is append-only.
 */
export const REQUEST_TYPES = ['request', 'report', 'inform', 'complaint'] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];

export const PRIORITIES = ['normal', 'important'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const STATUSES = ['open', 'in_progress', 'forwarded', 'resolved', 'closed', 'reopened'] as const;
export type RequestStatus = (typeof STATUSES)[number];

/** Not yet dealt with: what the queues, the dashboard and the app's "open" tab show. */
export const OPEN_STATUSES: RequestStatus[] = ['open', 'in_progress', 'forwarded', 'reopened'];

export const LEVELS = ['area_manager', 'super_admin'] as const;
export type Level = (typeof LEVELS)[number];

export const QUEUES = ['area_manager', 'super_admin', 'assignee'] as const;
export type Queue = (typeof QUEUES)[number];

export const TIMELINE_KINDS = ['created', 'comment', 'forwarded', 'assigned', 'status_changed', 'resolved', 'reopened', 'closed'] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

export const MAX_PHOTOS = 5;
/** Bootstrap keeps closed requests of this many Dhaka days, besides every one still open. */
export const SNAPSHOT_CLOSED_DAYS = 30;

/** important → super admin queue, normal → area manager queue (FR-REQ-002). */
export const levelFor = (priority: Priority): Level => (priority === 'important' ? 'super_admin' : 'area_manager');

export type Action = 'comment' | 'forward' | 'assign' | 'resolve' | 'reopen' | 'close';
export type Rule = { ok: true } | { ok: false; reason: string };

/** Which status an action may start from (FR-REQ-003). The resulting status is `statusAfter`. */
export function checkAction(action: Action, status: RequestStatus): Rule {
  const closed = status === 'closed';
  const done = status === 'resolved' || closed;
  switch (action) {
    case 'comment':
      return closed ? { ok: false, reason: 'REQUEST_CLOSED' } : { ok: true };
    case 'forward':
    case 'assign':
    case 'resolve':
      return done ? { ok: false, reason: closed ? 'REQUEST_CLOSED' : 'REQUEST_RESOLVED' } : { ok: true };
    case 'reopen':
      return done ? { ok: true } : { ok: false, reason: 'REQUEST_OPEN' };
    case 'close':
      return closed ? { ok: false, reason: 'REQUEST_CLOSED' } : { ok: true };
  }
}

export function statusAfter(action: Action, status: RequestStatus): RequestStatus {
  switch (action) {
    case 'comment':
      return status;
    case 'forward':
      return 'forwarded';
    case 'assign':
      return 'in_progress';
    case 'resolve':
      return 'resolved';
    case 'reopen':
      return 'reopened';
    case 'close':
      return 'closed';
  }
}

/**
 * Who may act (FR-REQ-004). `manage` = holds request.manage; `top` = holds request.important.manage (the super admin
 * queue). Requests at super admin level are moved, resolved or closed only by `top`; the assignee may resolve what
 * was given to them; the creator may reopen or withdraw (close) their own.
 */
export function mayAct(
  action: Exclude<Action, 'comment'>,
  who: { manage: boolean; top: boolean; isCreator: boolean; isAssignee: boolean },
  level: Level,
): boolean {
  const office = level === 'super_admin' ? who.top : who.manage || who.top;
  switch (action) {
    case 'forward':
    case 'assign':
      return office;
    case 'resolve':
      return office || who.isAssignee;
    case 'reopen':
    case 'close':
      return office || who.isCreator;
  }
}

/**
 * Who is told about a request waiting in a queue (FR-REQ-005), without role names: the super admin queue is every
 * holder of request.important.manage; the area manager queue is every holder of request.manage who does not also
 * work the super admin queue, and the super admin queue itself when nobody is left (no area manager yet).
 */
export function queueAudience(level: Level, holders: { manage: string[]; top: string[] }): string[] {
  if (level === 'super_admin') return unique(holders.top);
  const top = new Set(holders.top);
  const areaManagers = holders.manage.filter((id) => !top.has(id));
  return unique(areaManagers.length ? areaManagers : holders.top);
}

const unique = (ids: string[]) => [...new Set(ids.filter(Boolean))];

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
