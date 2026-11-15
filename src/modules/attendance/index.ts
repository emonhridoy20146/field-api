/** Public API of the attendance module. */
export { isOnDuty, dutyWindows, onDutyNow, allOnDutyNow, recordEvent as recordAttendanceEvent, eventSchema as attendanceEventSchema, myToday as attendanceToday, todayCounts as attendanceCounts } from './service.js';
export { dutyStateAt, type DutyIntervals, type DutyState } from './domain/day.js';
