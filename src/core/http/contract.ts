/**
 * The API contract this build implements (`docs/openapi.yaml` info.version), reported by `GET /system/health` so a
 * deploy can be checked from a browser. test/integration/phase0.test.ts fails when the two differ: bump both.
 */
export const CONTRACT_VERSION = '1.34.0';
