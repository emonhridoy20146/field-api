import { FixedClock } from '../../src/core/time/index.js';

/** Freeze time at a Dhaka wall-clock moment, e.g. dhakaClock('2026-11-15T10:00'). */
export function dhakaClock(localIso: string): FixedClock {
  return new FixedClock(`${localIso}${localIso.length === 16 ? ':00' : ''}+06:00`);
}

export { FixedClock };
