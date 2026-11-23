/** Public API of the attendance module. */
export { isOnDuty, dutyWindows, onDutyNow, allOnDutyNow, lastEventGeo, recordEvent as recordAttendanceEvent, eventSchema as attendanceEventSchema, myToday as attendanceToday, todayCounts as attendanceCounts, days as attendanceDays, dayKindsOf } from './service.js';
export { dutyStateAt, type DutyIntervals, type DutyState } from './domain/day.js';
export { attendanceRequired } from './domain/required.js';
