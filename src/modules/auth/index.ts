/** Public API of the auth module. */
export { registerLoginGuard, revokeAllForUser, revokeForDevice, issueTrackingToken, resolveTrackingToken, type LoginGuard, type DeviceInfo, type TrackingTokenProblem } from './service.js';
