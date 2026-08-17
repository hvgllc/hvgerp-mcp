/**
 * The release version this build reports to clients.
 *
 * Duplicated on purpose rather than read from `deno.json` at runtime: the npm build bundles source
 * with esbuild and does not ship `deno.json`, so a runtime read would be a file that is not there.
 * The duplication is guarded by `src/version_test.ts`, which fails when this constant and
 * `deno.json` drift apart - which is exactly what happened when `deno.json` was bumped to 3.1.0 and
 * the `McpApp` constructor kept announcing 3.0.0 to every client inspecting server metadata.
 *
 * Bumping a release means editing BOTH (AGENTS.md, "Version locations").
 *
 * @module lib/erpnext/src/version
 */

export const SERVER_VERSION = "3.1.0";
