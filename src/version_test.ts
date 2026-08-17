/**
 * Guard against the two version locations drifting apart.
 *
 * AGENTS.md names both (`deno.json` -> `version`, and the `McpApp` constructor in `server.ts`), and
 * they did drift: 3.1.0 in the manifest, 3.0.0 announced at runtime. `server.ts` now reads
 * `SERVER_VERSION`, so one comparison covers both.
 *
 * @module lib/erpnext/src/version_test
 */

import { assert, assertEquals } from "@std/assert";
import { SERVER_VERSION } from "./version.ts";

Deno.test("SERVER_VERSION matches the version in deno.json", async () => {
  const manifest = JSON.parse(
    await Deno.readTextFile(new URL("../deno.json", import.meta.url)),
  ) as { version?: unknown };

  assertEquals(
    typeof manifest.version,
    "string",
    "deno.json must declare a version",
  );
  assertEquals(
    SERVER_VERSION,
    manifest.version,
    "src/version.ts and deno.json disagree - bumping a release must update both " +
      "(AGENTS.md, 'Version locations')",
  );
});

Deno.test("server.ts announces the shared constant, not a literal", async () => {
  const source = await Deno.readTextFile(
    new URL("../server.ts", import.meta.url),
  );

  assert(
    /version:\s*SERVER_VERSION/.test(source),
    "the McpApp constructor must pass SERVER_VERSION; a literal here is what let the runtime " +
      "metadata fall behind deno.json",
  );
  assert(
    !/version:\s*["']\d+\.\d+\.\d+["']/.test(source),
    "server.ts must not hard-code a version string",
  );
});
