/** Public API of the targets module: only what other modules need. Never export from models/. */
export { targetsOf, mine as myTarget, type TargetTotals } from './service.js';
export { achievement } from './domain/resolve.js';
