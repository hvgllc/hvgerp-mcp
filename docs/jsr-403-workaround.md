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
at the package name, and the same error appears for `@std/assert` as soon as a
test file imports it.

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
- `@std/assert` → `https://deno.land/std@0.224.0/assert/mod.ts`. This is the one
  substitution that is **not** equivalent, and it stays that way: `deno.json`
  declares `jsr:@std/assert@^1`, and no 1.x copy is reachable from a blocked
  machine, because `@std/*` publishes to JSR only. `npm view @std/assert` and
  `npm view @jsr/std__assert` both answer `E404` (measured 2026-09-24), so the
  npm route that rescues `@casys/mcp-server` has nothing to offer here.
  `deno.land/std@0.224.0` is the last release before that move and it already
  sits in the `remote` section of `deno.lock`, so it resolves offline.
- `@std/yaml` → the same `deno.land/std@0.224.0` tree. `deno.json` declares it,
  but no file in the repository imports it today, so this entry is insurance
  against one appearing rather than a live substitution.

The `@std/assert` gap is bounded, and worth knowing exactly how far it reaches
before trusting a local green: all 68 files that import it are `*_test.ts`, so
it can only change how assertions behave in tests, never what ships. A test that
depends on 1.x-only assertion behaviour therefore passes here and fails on CI.
That is the right way round for a local workaround, and one more reason §6 is
the gate rather than this page.

It also has to restate the bare specifiers that `@casys/mcp-server` imports for
itself (`hono`, `ajv/`, `jose`, `yaml`, `@modelcontextprotocol/sdk/`, …) as
`npm:` specifiers. Vendored code is resolved against _your_ import map, not the
package's own, so anything the package imports bare must appear in yours.

### Writing the two local-only artifacts

Neither artifact is tracked, and `.git/info/exclude` is per-clone metadata that
no commit can carry, so a fresh clone starts with neither. Recreate both from
here. First tell your own clone to ignore them, so a stray `git add -A` cannot
commit one machine's network workaround:

```bash
printf '%s\n' '.nojsr-vendor/' 'deno.nojsr.json' >> .git/info/exclude
```

Then write `deno.nojsr.json` at the repository root. The path
`./.nojsr-vendor/…` resolves relative to this file, so the root is where it has
to live:

```jsonc
{
  "//": "Local-only config: this machine's network is blocked from *.jsr.io.",
  "nodeModulesDir": "auto",
  "minimumDependencyAge": { "age": "PT24H" },
  "imports": {
    "@casys/mcp-server": "./.nojsr-vendor/casys-mcp-server/mod.ts",
    "@modelcontextprotocol/sdk/": "npm:/@modelcontextprotocol/sdk@^1.29.0/",
    "@modelcontextprotocol/ext-apps": "npm:@modelcontextprotocol/ext-apps@^1.7.4",
    "@opentelemetry/api": "npm:@opentelemetry/api@^1.9.0",
    "ajv/": "npm:/ajv@^8.17.1/",
    "hono": "npm:hono@^4.0.0",
    "hono/": "npm:/hono@^4.0.0/",
    "jose": "npm:jose@^6.0.0",
    "yaml": "npm:yaml@^2.7.0",
    "@std/yaml": "https://deno.land/std@0.224.0/yaml/mod.ts",
    "@std/assert": "https://deno.land/std@0.224.0/assert/mod.ts"
  }
}
```

Two things in that file are easy to get wrong.

**`minimumDependencyAge` is not decoration.** `deno.json` declares
`{"age": "PT24H"}`, so CI never resolves an npm release younger than a day. A
config without it can resolve a package CI deliberately skips, which turns the
workaround into a different dependency graph rather than a stand-in for the real
one. Copy the age across. `deno.json` also excludes `jsr:@casys/mcp-server` from
the policy; that exclusion is meaningless here, because this config reads that
package off the disk instead of resolving it.

**The `npm:` ranges come from the vendored package, not from `deno.json`.**
`deno.json` declares only `@casys/mcp-server`, `@opentelemetry/api` and the two
`@std/*` identifiers. Everything else in the map above exists because
`@casys/mcp-server` imports it bare, so its own manifest is the source of truth.
After every re-vendor, re-read it and reconcile:

```bash
jq -r '.dependencies | to_entries[] | "\(.key)@\(.value)"' \
  .nojsr-vendor/casys-mcp-server/package.json
```

Update any range that moved, and add any dependency that appeared - a new bare
import with no entry in your map fails to resolve, while a stale range silently
type-checks against the wrong version. Entries are needed in the `"name/"` form
as well as the plain one when the package imports sub-paths (`ajv/`, `hono/`,
`@modelcontextprotocol/sdk/` above).

There is deliberately no `tasks` block. Adding one does not make `deno task`
work against this config, it only changes which error you get; §5 shows both.

### Rebuilding `.nojsr-vendor/` from scratch

```bash
# Resolve the RANGE, do not strip it. `^0.25.0` in deno.json is what CI resolves
# against, so vendoring the literal `0.25.0` would type-check against an older
# release the moment 0.25.1 ships - a silent false green, not a loud failure.
RANGE=$(grep '"@casys/mcp-server"' deno.json |
        sed 's/.*@casys\/mcp-server@\([^"]*\)".*/\1/')
VER=$(npm view "@casys/mcp-server@${RANGE}" version | tail -n1 | tr -d "'" |
      awk '{print $NF}')
echo "vendoring @casys/mcp-server@${VER} for range ${RANGE}"

VENDOR=/path/to/hvgerp-mcp/.nojsr-vendor/casys-mcp-server
cd "$(mktemp -d)"
npm pack "@casys/mcp-server@${VER}" --registry=https://registry.npmjs.org
tar -xzf "casys-mcp-server-${VER}.tgz"
mkdir -p "$VENDOR"
rsync -a --delete package/ "$VENDOR"/
```

The `mkdir -p` is not redundant, and which machine you are on decides whether
you find that out. GNU rsync creates only the final destination directory, so on
a fresh clone - where `.nojsr-vendor/` itself does not exist yet - it stops at
`mkdir "…/casys-mcp-server" failed: No such file or directory` and exits 11
(measured with rsync 3.5.0). macOS ships openrsync, which creates the whole path
and exits 0, so the same line works there and hides the problem. `--mkpath`
fixes it on GNU rsync only - openrsync answers `unrecognized option`, so
`mkdir -p` is the portable form.

`npm view <pkg>@<range> version` prints one bare version when a single release
matches and `<pkg>@<v> '<v>'` lines in ascending order when several do, which is
why the pipeline takes the last line and its last field.

If you still have a `deno.lock` from before the block, it names the version Deno
itself resolved - cross-check it and prefer it when the two disagree, because it
is what the machine with working JSR access saw:

```bash
grep -o '@casys/mcp-server@[0-9][^"_]*' deno.lock | head -1
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

Measured on 2026-09-24 with Deno 2.9.5 and vendored `@casys/mcp-server@0.25.0`,
using the config exactly as written in §3: type check clean,
`1502 passed | 0 failed | 4 ignored`. `deno.lock` is left untouched by both, so
the workaround leaves no trace in the working tree.

`deno fmt` and `deno lint` need no config at all - neither resolves imports.

## 5. Traps

**`deno task` cannot be redirected with `--config`.** It fails twice, and the
first failure hides the second. With the config from §3, `--config` _replaces_
the config file rather than layering on it, so `deno.json`'s task list is simply
not there:

```bash
$ deno task --config deno.nojsr.json check
Task not found: check
Available tasks:
  No tasks found in configuration file
```

The obvious repair is to copy the `tasks` block across. Do that and the command
gets further, then lands exactly where it started:

```bash
$ deno task --config deno.nojsr.withtasks.json check
Task check deno check mod.ts server.ts
error: JSR package manifest for '@casys/mcp-server' failed to load… 403 Forbidden
```

The flag configures the task _runner_; the command it then spawns is a fresh
`deno check` with no flags of its own, which loads `deno.json` and hits the
block. Both transcripts were measured on 2026-09-24. Every `deno task` that
resolves imports - `check`, `test`, `release:check` - is unusable on a blocked
machine, whichever config you point the runner at. Run the underlying command
directly, with the flags from §4.

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

`Test` is manual-only (`workflow_dispatch`) and runs six steps. Five of them are
the ones the local commands cover: `deno fmt --check`, `deno lint`,
`deno task check`, the UI build, and `deno test --allow-all src/`. The sixth is
`deno task release:check`, and it is the one §4 does not reach.

`release:check` runs `scripts/release-check.sh`, which repeats those five and
then adds `scripts/build-node.sh`. The wrapper task is unreachable here for the
reason §5 gives - it calls `deno task check` internally, so `--config` cannot
follow it in - but the step it adds is not:

```bash
bash scripts/build-node.sh
```

That script resolves `@casys/mcp-server` from npm by design (it builds the Node
package), so it needs nothing from JSR and runs on a blocked machine: measured
2026-09-24, exit 0, writing `dist-node/bin`. Run it directly when a change
touches the Node build; for everything else the CI run is what closes the gap.

Publishing is not affected either. `.github/workflows/publish.yml` runs on a
published release; its `publish-jsr` job is gated on the repository variable
`PUBLISH_JSR` and skips while that is unset, so only npm ships today. If JSR
publishing is ever enabled, it will run on a GitHub runner and will not see this
`403`.
