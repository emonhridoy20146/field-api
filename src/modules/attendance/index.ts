/** Public API of the attendance module. */
export { isOnDuty, recordEvent as recordAttendanceEvent, eventSchema as attendanceEventSchema, myToday as attendanceToday, todayCounts as attendanceCounts } from './service.js';
