# Working around a `403 Forbidden` from jsr.io

Some networks get a blanket `403 Forbidden` from JSR. Every `*.jsr.io` host is
affected at once - `jsr.io`, `api.jsr.io` and `npm.jsr.io` - while
`registry.npmjs.org` and `deno.land` keep answering normally. When that happens
on your machine, nothing in this repository that resolves a `jsr:` specifier can
run: `deno check`, `deno test`, `deno task check` and `deno task release:check`
all stop at the same wall.

This page is the recovery recipe. It is written for whoever (or whatever) picks
up the repository next, so it states the symptom, the measurement that confirms
the diagnosis, the local workaround, and - the part that is easy to get wrong -
which commands the workaround does **not** fix.

## 1. The symptom

```
$ deno check mod.ts server.ts
Download https://jsr.io/@casys/mcp-server/meta.json
error: JSR package manifest for '@casys/mcp-server' failed to load.
Import 'https://jsr.io/@casys/mcp-server/meta.json' failed: 403 Forbidden
    at file:///…/src/auth/composite-provider.ts:14:8
```

The message names a package, so it reads like a broken or unpublished
dependency. It is not. `403` is an access decision made before JSR ever looked
at the package name, and the same error appears for `@std/assert` and
`@std/yaml` as soon as a test file imports one.

**Do not "fix" this by changing a dependency, pinning a different version, or
deleting `deno.lock`.** None of those touch the cause, and the last one throws
away a working lockfile.

## 2. Confirm it in 30 seconds

```bash
for h in jsr.io api.jsr.io npm.jsr.io deno.land registry.npmjs.org; do
  printf '%-22s %s\n' "$h" \
    "$(curl -s -o /dev/null -w '%{http_code}' --max-time 12 "https://$h/")"
done
```

A blocked machine prints `403` for all three JSR hosts and a non-`403` for the
other two. If JSR answers `200` here, your problem is something else and this
page does not apply.

The block is per-network, not per-account: a GitHub Actions runner reaches JSR
fine, which is why CI is the real gate while a local machine is blocked (see
§6).

## 3. The workaround: a local-only Deno config

Two artifacts do the work. Neither is committed - both are listed in
`.git/info/exclude`, because they describe one machine's network, not the
project:

| Path              | Role                                                           |
| ----------------- | -------------------------------------------------------------- |
| `deno.nojsr.json` | A Deno config whose import map replaces every `jsr:` specifier |
| `.nojsr-vendor/`  | A local copy of `@casys/mcp-server`, fetched from npm          |

The import map redirects the three JSR identifiers this project uses:

- `@casys/mcp-server` → `./.nojsr-vendor/casys-mcp-server/mod.ts`. The same
  source is published to npm under the same name and the same version numbers,
  so npm is an exact substitute for the JSR copy.
- `@std/assert` and `@std/yaml` → `https://deno.land/std@0.224.0/…`. These were
  already in the `remote` section of `deno.lock`, so they resolve offline.

It also has to restate the bare specifiers that `@casys/mcp-server` imports for
itself (`hono`, `ajv/`, `jose`, `yaml`, `@modelcontextprotocol/sdk/`, …) as
`npm:` specifiers. Vendored code is resolved against _your_ import map, not the
package's own, so anything the package imports bare must appear in yours.

### Rebuilding `.nojsr-vendor/` from scratch

```bash
VER=$(grep '"@casys/mcp-server"' deno.json |
      sed 's/.*@casys\/mcp-server@^\{0,1\}\([^"]*\)".*/\1/')
cd "$(mktemp -d)"
npm pack "@casys/mcp-server@${VER}" --registry=https://registry.npmjs.org
tar -xzf "casys-mcp-server-${VER}.tgz"
rsync -a --delete package/ /path/to/hvgerp-mcp/.nojsr-vendor/casys-mcp-server/
```

Two details explain the shape of this:

- **It must live outside `node_modules/`.** The npm package ships `.ts` sources,
  and Deno refuses to strip types from a `.ts` file found inside
  `node_modules/`. Copying the same files to a plain directory sidesteps that.
- **Its internal imports end in `.js` but point at `.ts` files** (the TypeScript
  `NodeNext` convention). Deno rejects that by default with 18 `TS2307` errors
  reading
  `Cannot find module '….js'. Maybe change the extension to '.ts' or run
  with --sloppy-imports`.
  Passing `--sloppy-imports` is the fix; rewriting the vendored imports is not,
  because the next `npm pack` would undo it.

## 4. Commands that work, and how to invoke them

```bash
deno check --config deno.nojsr.json --sloppy-imports mod.ts server.ts
deno test  --config deno.nojsr.json --sloppy-imports --allow-all src/
```

Measured on 2026-09-05 with Deno 2.9.5 and vendored `@casys/mcp-server@0.25.0`:
type check clean, `762 passed | 0 failed | 4 ignored`. `deno.lock` is left
untouched by both, so the workaround leaves no trace in the working tree.

`deno fmt` and `deno lint` need no config at all - neither resolves imports.

## 5. Traps

**`deno task` cannot be redirected with `--config`.** This looks like it should
work and silently does not:

```bash
$ deno task --config deno.nojsr.json check
Task check deno check mod.ts server.ts
error: … 403 Forbidden
```

The flag configures the task _runner_; the command it then spawns is a fresh
`deno check`, which loads `deno.json` on its own. Every `deno task` that
resolves imports - `check`, `test`, `release:check` - is unusable on a blocked
machine. Run the underlying command directly, with the flags from §4.

**`--no-check` does not help.** It skips type checking, not module resolution:

```
$ deno test --no-check --allow-all src/tools/
error: JSR package manifest for '@std/assert' failed to load … 403 Forbidden
```

**`deno fmt` reformats `.nojsr-vendor/`.** It walks dot-directories (`deno lint`
does not), so a plain `deno fmt` will rewrite vendored files. That does not
dirty git - the directory is excluded - but it makes the vendor drift from the
published tarball, so a later `diff` against a fresh `npm pack` shows changes
that are formatting, not patches. Prefer `deno fmt <specific paths>`, or
remember this before concluding the vendor was modified.

**Bumping `@casys/mcp-server` means re-vendoring.** The import map points at a
fixed directory, so after changing the version in `deno.json` the local vendor
still holds the old code and a local type check will happily pass against the
wrong API. Re-run §3, then re-check.

## 6. CI is the real gate

Because the block is per-network, hosted runners are unaffected. Confirm work
there rather than trusting a partially-working local run:

```bash
gh workflow run Test --ref <branch>
```

`Test` is manual-only (`workflow_dispatch`) and runs the same five steps the
local commands cover: `deno fmt --check`, `deno lint`, `deno task check`, the UI
build, and `deno test --allow-all src/`.

Publishing is not affected either. `.github/workflows/publish.yml` runs on a
published release; its `publish-jsr` job is gated on the repository variable
`PUBLISH_JSR` and skips while that is unset, so only npm ships today. If JSR
publishing is ever enabled, it will run on a GitHub runner and will not see this
`403`.
