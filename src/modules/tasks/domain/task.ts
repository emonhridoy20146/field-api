/**
 * Life of an admin task (FR-TASK-001..004). Pure rules, no I/O.
 *
 *   open ──request_resolve──▶ resolve_requested ──verify──▶ resolved
 *    ▲                              │
 *    └──────────── reject ──────────┘            cancel (from open or resolve_requested) ──▶ cancelled
 */
export type TaskStatus = 'open' | 'resolve_requested' | 'resolved' | 'cancelled';
export type TaskAction = 'request_resolve' | 'verify' | 'reject' | 'cancel' | 'edit';

export const TASK_STATUSES: TaskStatus[] = ['open', 'resolve_requested', 'resolved', 'cancelled'];
export const isClosed = (s: TaskStatus) => s === 'resolved' || s === 'cancelled';

export interface Transition {
  to: TaskStatus;
  /** The task is already in the state this action leads to (a retry): answer with the current task, change nothing. */
  replay: boolean;
}

const NEXT: Record<TaskAction, { from: TaskStatus[]; to: TaskStatus }> = {
  request_resolve: { from: ['open'], to: 'resolve_requested' },
  verify: { from: ['resolve_requested'], to: 'resolved' },
  reject: { from: ['resolve_requested'], to: 'open' },
  cancel: { from: ['open', 'resolve_requested'], to: 'cancelled' },
  // Wording and due date can change only while the staff member has not reported the work done.
  edit: { from: ['open'], to: 'open' },
};

/** `null` = not allowed from this state. Staff retries (offline sync) must not fail, so a repeat is a replay. */
export function transition(from: TaskStatus, action: TaskAction): Transition | null {
  const n = NEXT[action];
  if (n.from.includes(from)) return { to: n.to, replay: false };
  // Only the idempotent actions replay: a reject or edit that finds the task open again is a different fact.
  if ((action === 'request_resolve' || action === 'verify' || action === 'cancel') && from === n.to) return { to: n.to, replay: true };
  return null;
}

/** Overdue = still not finished and the Dhaka due date has passed (a task due today is not overdue until tomorrow). */
export function isOverdue(status: TaskStatus, dueDate: string | null, today: string): boolean {
  return !!dueDate && (status === 'open' || status === 'resolve_requested') && dueDate < today;
}
