// Single source of truth for the version reported in log entries (agent.version).
// Covered by tests/version.test.ts, which fails the suite if this drifts from package.json.
export const LIB_VERSION = '1.0.1';
