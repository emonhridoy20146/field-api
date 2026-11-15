/** Public API of the settings module. */
export {
  getSetting,
  getMany,
  appSettings,
  setSystem,
  clearSettingsCache,
  resolveShift,
  isWorkingDay,
  isHoliday,
  type ShiftView,
} from './service.js';
