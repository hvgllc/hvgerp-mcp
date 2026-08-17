import { assert, assertEquals } from "@std/assert";
import { resolveViewerDistPath } from "./viewer-resource-paths.ts";

Deno.test("resolveViewerDistPath prefers source dist in repo mode", () => {
  const resolved = resolveViewerDistPath(
    "file:///workspace/lib/erpnext/server.ts",
    "kanban-viewer",
    (path: string) =>
      path === "/workspace/lib/erpnext/src/ui/dist/kanban-viewer/index.html",
  );

  assertEquals(
    resolved,
    "/workspace/lib/erpnext/src/ui/dist/kanban-viewer/index.html",
  );
});

Deno.test("resolveViewerDistPath falls back to packaged ui-dist for npm bundle", () => {
  const resolved = resolveViewerDistPath(
    "file:///workspace/lib/erpnext/dist-node/bin/hvgerp-mcp.mjs",
    "kanban-viewer",
    (path: string) =>
      path ===
        "/workspace/lib/erpnext/dist-node/bin/ui-dist/kanban-viewer/index.html",
  );

  assertEquals(
    resolved,
    "/workspace/lib/erpnext/dist-node/bin/ui-dist/kanban-viewer/index.html",
  );
});

Deno.test("resolveViewerDistPath resolves Windows file URLs for packaged ui-dist", () => {
  const resolved = resolveViewerDistPath(
    "file:///C:/workspace/lib/erpnext/dist-node/bin/hvgerp-mcp.mjs",
    "kanban-viewer",
    (path: string) =>
      path ===
        "C:/workspace/lib/erpnext/dist-node/bin/ui-dist/kanban-viewer/index.html",
  );

  assertEquals(
    resolved,
    "C:/workspace/lib/erpnext/dist-node/bin/ui-dist/kanban-viewer/index.html",
  );
});

Deno.test("resolveViewerDistPath returns null when no viewer build exists", () => {
  const resolved = resolveViewerDistPath(
    "file:///workspace/lib/erpnext/server.ts",
    "kanban-viewer",
    () => false,
  );

  assertEquals(resolved, null);
});

Deno.test("Dockerfile.bundle keeps the traverse bit on the packaged ui-dist tree", async () => {
  // A source assertion rather than a `docker build`: the image needs a prebuilt
  // bundle and the round trip runs for minutes. What it catches is the regression
  // that was measured on this very image - `--chmod=0644` applied to a directory
  // TREE gave `drw-r--r-- /app/ui-dist`, `ls` answered `Permission denied`, and the
  // server came up with `Resources: 0`, reading like a missing build artifact.
  const source = await Deno.readTextFile(
    new URL("../../Dockerfile.bundle", import.meta.url),
  );

  assert(
    !/COPY\s+--chmod=0[0-7]*[0-6]\s+dist-node\/bin\/ui-dist/.test(source),
    "Dockerfile.bundle must not COPY the ui-dist tree with a mode that drops the " +
      "directory traverse bit: COPY applies one mode to directories and files alike",
  );
  assert(
    /find \/app\/ui-dist -type d -exec chmod 0755/.test(source),
    "Dockerfile.bundle must give every ui-dist directory the traverse bit back",
  );
  assert(
    /find \/app\/ui-dist -type f -exec chmod 0644/.test(source),
    "Dockerfile.bundle must normalise ui-dist file modes instead of trusting the " +
      "build host umask",
  );
});

Deno.test("the doclist viewer pins erpnext_my_work's section column", async () => {
  // `erpnext_my_work` folds six doctypes into one table and `section` is the only
  // column that says which group a row came from. The table shows at most
  // MAX_VISIBLE_COLUMNS columns, so leaving it to the alphabetical tail loses it.
  const source = await Deno.readTextFile(
    new URL("doclist-viewer/src/helpers.ts", import.meta.url),
  );

  const priority = source.match(/const PRIORITY_COLUMNS = \[([\s\S]*?)\]/);
  assert(priority, "helpers.ts must still declare PRIORITY_COLUMNS");
  assert(
    /"section"/.test(priority![1]),
    'PRIORITY_COLUMNS must list "section" so the flattened my-work table keeps it',
  );
});

Deno.test("Dockerfile.bundle's usage recipe builds the UI before the bundle", async () => {
  const source = await Deno.readTextFile(
    new URL("../../Dockerfile.bundle", import.meta.url),
  );

  // `scripts/build-node.sh` copies `src/ui/dist/` unconditionally under `set -e`, and that
  // directory is gitignored. A clean clone following the recipe as written died before it
  // ever produced `dist-node/` - the one directory this Dockerfile copies in.
  assert(
    /deno task ui:build\n#\s+\.\/scripts\/build-node\.sh/.test(source),
    "the recipe must run `deno task ui:build` before `./scripts/build-node.sh`",
  );
});
