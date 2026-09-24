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
probe() {
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 12 "https://$1/")
  curl_exit=$?
  printf '%-22s %-3s curl-exit=%s\n' "$1" "$code" "$curl_exit"
}

jsr_blocked=1
for h in jsr.io api.jsr.io npm.jsr.io; do
  probe "$h"
  [ "$code" = 403 ] || jsr_blocked=0
done

fallbacks_usable=1
for h in deno.land registry.npmjs.org; do
  probe "$h"
  { [ "$curl_exit" = 0 ] && [ "$code" -ge 200 ] && [ "$code" -lt 400 ]; } ||
    fallbacks_usable=0
done

if [ "$jsr_blocked" = 0 ]; then
  echo "JSR is not answering 403: this page does not apply" >&2
elif [ "$fallbacks_usable" = 0 ]; then
  echo "deno.land or registry.npmjs.org is unusable too: nothing here will work" >&2
else
  echo "this page applies"
fi
```

A blocked machine prints `403` for all three JSR hosts and a reachable 2xx/3xx
for the other two, and the block ends with `this page applies`. If JSR answers
`200`, your problem is something else.

The fallback hosts get the stricter check, and the reason is that an HTTP code
alone cannot tell "reachable" from "not reachable at all". `curl` prints `000`
when it never got a response, and `--max-time` only bounds the transfer, so a
DNS failure, a proxy refusal or a second blocked host all produce that same
`000` - which is not `403`, and a test for "non-403" therefore reads a dead
network as a healthy fallback. Measured 2026-09-24: `deno.land` answers `301`
with exit 0, `registry.npmjs.org` answers `200` with exit 0, and an unresolvable
host answers `000` with **exit 6**. The status code is the part command
substitution keeps and the exit code is the part it drops, so the probe captures
`$?` on the line after the substitution and requires both.

This matters because the rest of the page spends those two hosts: §3 fetches
`@casys/mcp-server` from `registry.npmjs.org` and the import map points `@std/*`
at `deno.land`. If they are blocked as well, the workaround has nowhere left to
resolve from, and finding that out here costs one command instead of three
sections.

(`code` and `curl_exit` rather than the more obvious `status`: `status` is
read-only in zsh, the default macOS shell, so the shorter name makes the block
abort with `read-only variable: status` on the machine most likely to run it.)

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
| `deno.nojsr.lock` | A lockfile of its own, so `deno.lock` is never written (§4)    |

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
  `deno.land/std@0.224.0` is the last release before that move, and §2 already
  established that `deno.land` answers normally while JSR does not, so it
  fetches on the first run and is pinned in `deno.nojsr.lock` afterwards.
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
printf '%s\n' '.nojsr-vendor/' 'deno.nojsr.json' 'deno.nojsr.lock' \
  >> "$(git rev-parse --git-path info/exclude)"
```

Ask git for the path rather than writing `.git/info/exclude` directly. In a
linked worktree - which this repository's own work uses routinely - `.git` is a
file, not a directory, so the literal path fails with
`not a directory: .git/info/exclude` before anything is written.
`git rev-parse
--git-path` returns the real location in both layouts (measured
2026-09-24 from a linked worktree: it resolves to the main checkout's
`.git/info/exclude`, which is shared across worktrees).

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
VER=$(npm view "@casys/mcp-server@${RANGE}" version \
        --registry=https://registry.npmjs.org | tail -n1 | tr -d "'" |
      awk '{print $NF}')
echo "vendoring @casys/mcp-server@${VER} for range ${RANGE}"

VENDOR=/path/to/hvgerp-mcp/.nojsr-vendor/casys-mcp-server
mkdir -p "$VENDOR"
( cd "$(mktemp -d)" &&
  npm pack "@casys/mcp-server@${VER}" --registry=https://registry.npmjs.org &&
  tar -xzf "casys-mcp-server-${VER}.tgz" &&
  rsync -a --delete package/ "$VENDOR"/ )
```

`npm view` needs the same explicit `--registry` as the `npm pack` below it. Both
are registry reads, and both honour `registry` from your user or global
`.npmrc`: with `npm_config_registry` pointed at an unreachable host the lookup
fails at `request to https://…/@casys%2fmcp-server failed`, and the same command
with the flag returns `0.25.0`. On a machine configured for a corporate mirror,
leaving the flag off resolves the range against that mirror and then packs a
possibly different version from the public registry.

The subshell matters if you are working through this page in one terminal. A
bare `cd "$(mktemp -d)"` leaves the shell in the temporary directory after the
block, and every later command here is relative to the repository root:
`deno.nojsr.json`, `mod.ts`, `server.ts` and `scripts/build-node.sh` all resolve
against the wrong place, so §4 and §6 fail before checking anything. Parentheses
confine the `cd` to the copy step.

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
resolved back then. Read it as a diagnostic, not as the answer: when it
disagrees with the range, take the range. §4 explains why - CI keeps no
lockfile, so it resolves the newest release the range allows, and an old lock
records history rather than what CI will do today. A disagreement is worth
understanding (it usually means a release landed since), but vendoring the older
version to match the lock is how you get a local pass against code CI never
runs:

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
deno check --lock=deno.nojsr.lock --config deno.nojsr.json --sloppy-imports \
  mod.ts server.ts
deno test  --lock=deno.nojsr.lock --config deno.nojsr.json --sloppy-imports \
  --allow-all src/
```

Measured on 2026-09-24 with Deno 2.9.5 and vendored `@casys/mcp-server@0.25.0`,
using the config exactly as written in §3: type check clean,
`1502 passed | 0 failed | 4 ignored`, and `deno.lock` byte-identical before and
after.

**`--lock` is what keeps that true, not luck.** These commands resolve a
different dependency graph - vendored source, `npm:` ranges, `deno.land` - so
whatever lockfile they are given ends up describing that graph instead of the
real one. Without `--lock` they write `deno.lock` itself: on a clone that has
none, the run creates one, and the file it creates carries **zero** `jsr`
entries (measured). On a clone that kept its pre-block `deno.lock` - the one §3
tells you to cross-check against - that same file becomes the workaround's
lockfile. `--no-lock` also protects it, at the cost of re-resolving every run.

**A separate lock file is not free either - it goes stale, and quietly.** Once
`deno.nojsr.lock` exists it pins the whole graph: 96 npm packages, including
transitive ones, behind 7 declared ranges (measured 2026-09-24, e.g.
`npm:@modelcontextprotocol/sdk@^1.29.0` → `1.30.0`). CI has no such anchor -
`deno.lock` is gitignored, so a hosted run starts from a fresh checkout with no
lockfile and resolves the newest release each range allows that is old enough
for `minimumDependencyAge`. Leave the local lock alone for a few weeks and the
two graphs drift apart, with the local one the more optimistic of the pair.
Re-vendoring does not fix this on its own: it replaces `@casys/mcp-server` and
leaves every pinned transitive dependency where it was.

Delete it and let the next run rebuild it whenever the graph should move:

```bash
rm -f deno.nojsr.lock
```

Do that after re-vendoring, after changing any range in `deno.json` or in the
vendored `package.json`, and whenever local checks pass while CI fails on
something that smells like a dependency version. It costs one slower run.

Do not try to verify this with `git status`: `deno.lock` is listed in
`.gitignore`, so git reports it clean no matter what happened to it. Compare the
file instead (`shasum deno.lock` before and after) - that is the check that
actually sees a rewrite.

**On a fresh clone this suite is greener than it looks.** `src/ui/dist/` is
gitignored, and the bundle regression in `src/ui/viewer_handshake_test.ts`
starts by reading those bundles and returns early when none are there
(`if (present.length === 0) return;`). It does not skip, fail or warn - it
passes, and the counts are identical either way: that file reports
`2 passed | 0 failed` with the bundles present and `2 passed | 0 failed` with
the directory moved aside (measured 2026-09-24). Nothing in the output tells you
which run actually checked a bundle. CI never hits this because it builds the
viewers before its test step; locally you have to build them yourself, which is
§6, and then re-run the test.

`deno fmt` and `deno lint` resolve no imports, so neither needs the config - but
both walk into `.nojsr-vendor/` and judge npm sources by this repository's
rules, so both need to be told to skip it:

```bash
deno fmt  --check --ignore=.nojsr-vendor/
deno lint --ignore='.nojsr-vendor,src/ui/**/*.tsx,src/ui/**/*.mjs,src/ui/node_modules/'
```

Measured 2026-09-24 against a vendor restored straight from `npm pack`: plain
`deno fmt --check` reports a file inside `.nojsr-vendor/` and exits 1, while the
`--ignore` form reports none and skips the 58 vendored files. `deno lint` checks
216 files with the vendor in place and 160 with it moved aside - it is reading
56 files of somebody else's code - and it also prints one
`Download https://jsr.io/…` line on the way, which is a metadata probe, not a
gate.

**The long lint ignore list is not padding.** `--ignore` on the command line
_replaces_ `lint.exclude` from `deno.json` rather than adding to it, so
`deno lint --ignore=.nojsr-vendor/` drops the vendor and simultaneously drags
`src/ui/**/*.tsx` and `src/ui/**/*.mjs` back in: 194 files, none of which CI
lints. Restating the three excludes alongside the vendor gets back to exactly
160, the same set a machine with no vendor lints. `deno fmt` happens not to need
this - its only config exclude is `src/ui/node_modules/`, which Deno skips
anyway (319 files either way) - but the flag behaves the same, so restate any
`fmt.exclude` that is ever added.

The bare commands are the CI gate reproduced faithfully only on a machine with
no vendor; here they are false failures, and §5 explains why running plain
`deno fmt` to silence one is worse than the failure.

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

**`deno fmt` reformats `.nojsr-vendor/`.** Both it and `deno lint` walk
dot-directories (measured: §4), but only `fmt` writes, so a plain `deno fmt`
will rewrite vendored files while a plain `deno lint` merely reports on them.
That does not dirty git - the directory is excluded - but it makes the vendor
drift from the published tarball, so a later `diff` against a fresh `npm pack`
shows changes that are formatting, not patches. Use `--ignore=.nojsr-vendor/`
(§4) to run the gate over the whole repository without touching the copy, and
remember this before concluding the vendor was modified.

**Bumping `@casys/mcp-server` means re-vendoring.** The import map points at a
fixed directory, so after changing the version in `deno.json` the local vendor
still holds the old code and a local type check will happily pass against the
wrong API. Re-run §3, then re-check.

## 6. CI is the real gate

Because the block is per-network, hosted runners are unaffected. Confirm work
there rather than trusting a partially-working local run:

```bash
BRANCH=$(git rev-parse --abbrev-ref HEAD)

# The runner checks out the GitHub ref, so nothing that is only local is in the
# run. Refuse to dispatch until the tree is clean and the branch is pushed.
[ -z "$(git status --porcelain)" ] || { echo "commit or stash first" >&2; exit 1; }
git fetch -q origin "$BRANCH"
EXPECTED_SHA=$(git rev-parse HEAD)
[ "$EXPECTED_SHA" = "$(git rev-parse "origin/$BRANCH")" ] ||
  { echo "push $BRANCH first" >&2; exit 1; }

LATEST_BEFORE=$(gh run list --workflow=Test --branch="$BRANCH" --limit 1 \
                  --json databaseId --jq '.[0].databaseId // 0')

DISPATCH_OUTPUT=$(gh workflow run Test --ref "$BRANCH") || exit 1
echo "$DISPATCH_OUTPUT"
RUN_ID=${DISPATCH_OUTPUT##*/}

# The run URL is printed only "if available". When it is not, the output is a
# confirmation sentence and ${DISPATCH_OUTPUT##*/} is its last word, so test for
# digits rather than trusting the substitution, and ask the API instead.
case "$RUN_ID" in
  '' | *[!0-9]*)
    RUN_ID=
    for _attempt in 1 2 3 4 5 6 7 8 9 10; do
      sleep 3
      CANDIDATE=$(gh run list --workflow=Test --branch="$BRANCH" --limit 1 \
                    --json databaseId --jq '.[0].databaseId // 0')
      if [ "$CANDIDATE" != "$LATEST_BEFORE" ] && [ "$CANDIDATE" != 0 ]; then
        RUN_ID=$CANDIDATE
        break
      fi
    done
    [ -n "$RUN_ID" ] || { echo "dispatch registered no new run" >&2; exit 1; } ;;
esac

ACTUAL_SHA=$(gh run view "$RUN_ID" --json headSha --jq .headSha)
[ "$ACTUAL_SHA" = "$EXPECTED_SHA" ] ||
  { echo "run $RUN_ID tests $ACTUAL_SHA, not $EXPECTED_SHA" >&2; exit 1; }

# `gh run watch` blocks with live progress, but its own help says it cannot
# authenticate with a fine-grained PAT, because `checks:read` cannot be granted
# to one. Polling `gh run view` needs only `actions:read`, so it covers that
# case; it also costs nothing when the watch exited non-zero because the RUN
# failed, since the run is already `completed` by the first iteration.
if ! gh run watch "$RUN_ID" --exit-status; then
  until [ "$(gh run view "$RUN_ID" --json status --jq .status)" = completed ]; do
    sleep 10
  done
fi

CONCLUSION=$(gh run view "$RUN_ID" --json conclusion --jq .conclusion)
[ "$CONCLUSION" = success ] ||
  { echo "run $RUN_ID finished: $CONCLUSION" >&2; exit 1; }
echo "run $RUN_ID confirmed $EXPECTED_SHA"
```

Dispatching is not confirming. `gh workflow run` only creates the
`workflow_dispatch` event and returns straight away, so on its own it exits 0
whatever the run later does. `gh run watch` is what waits for completion, and
`--exit-status` is what turns a failed run into a non-zero exit instead of a
report you then have to read.

Getting the run id is the fiddly part. On gh 2.101.0 the dispatch printed
`https://github.com/hvgllc/hvgerp-mcp/actions/runs/35989153502` and the id is
just its last path segment, but `gh workflow run --help` promises the URL only
"if available", and the older `✓ Created workflow_dispatch event for test.yml`
form has no id in it at all. Handing that sentence's last word to `gh run watch`
produces `failed to get run: HTTP 404: Not Found` against a URL ending in that
word rather than a gate, so the recipe tests for digits and falls back to the
API. `LATEST_BEFORE` is what makes the fallback safe: `gh run list --limit 1`
returns the previous dispatch until GitHub registers the new one, so polling
until the id CHANGES is the difference between watching this run and
re-confirming the last one.

The commit checks at the top are not ceremony, and this page's own history is
the evidence. `actions/checkout@v5` in `.github/workflows/test.yml` checks out
the ref GitHub resolves at dispatch time, so uncommitted or unpushed work is
simply not in the run. Measured while writing this section: a dispatch issued
with HEAD at `5f1622d5` produced run `35989153502`, two further commits landed
on the branch, and `gh run view 35989153502 --json headSha` still reports
`5f1622d560f8…`. The green tick was real and confirmed nothing about the work
written after it. Comparing the run's `headSha` against the local HEAD is what
turns "a run passed" into "this commit passed"; the `git fetch` before it is
what stops a local-only commit from being compared against a stale remote ref.

Note that `Test` sets `concurrency` with `cancel-in-progress: true` per ref, so
dispatching again while an earlier run is still going cancels that earlier one.
The `CONCLUSION` check catches it: a cancelled run reports `cancelled`, not
`success`, rather than silently looking unfinished.

`Test` is manual-only (`workflow_dispatch`) and runs six steps. Five of them are
the ones the local commands cover: `deno fmt --check`, `deno lint`,
`deno task check`, the UI build, and `deno test --allow-all src/`. The sixth is
`deno task release:check`, and it is the one §4 does not reach.

`release:check` runs `scripts/release-check.sh`, which repeats those five and
then adds `scripts/build-node.sh`. The wrapper task is unreachable here for the
reason §5 gives - it calls `deno task check` internally, so `--config` cannot
follow it in - but the step it adds is not:

```bash
(cd src/ui && npm ci && npm run typecheck && node build-all.mjs) &&
  bash scripts/build-node.sh &&
  deno test --lock=deno.nojsr.lock --config deno.nojsr.json --sloppy-imports \
    --allow-all src/ui/viewer_handshake_test.ts
```

Four steps, and every one of them earns its place.

**The `&&` between them is load-bearing.** Pasted into a shell without `set -e`,
three unchained commands report only the last one's status, and the last one
here passes when the earlier ones fail. Measured 2026-09-24 with `src/ui/dist`
moved aside to imitate a fresh clone: `scripts/build-node.sh` exits 1 at
`cp: src/ui/dist: No such file or directory`, and the `deno test` that follows
reports `ok | 2 passed | 0 failed` anyway, because
`src/ui/viewer_handshake_test.ts` returns early when no bundles exist. So the
unchained sequence exits 0 on a run where the build never happened - the exact
false green §4 warns about, one section later.

**`npm ci` and `node build-all.mjs`, not `deno task ui:install` / `ui:build`.**
The tasks run the same two commands (`deno.json` defines them as exactly that),
but running them _through_ `deno task` loads `deno.json` and rewrites
`deno.lock` on the way - measured 2026-09-24, `943deec7…` → `6ab4a5ae…`, from a
task that resolves no Deno import at all. That undoes the isolation §4 just
bought. `plans/evidence/001.md` records the same thing from the other side: a
`deno task ui:build` mid-run changed the lock and made the next `--frozen` check
fail, while a direct `node build-all.mjs` left it alone.

**`npm run typecheck` is not covered by anything else here.**
`src/ui/build-all.mjs` only shells out to `npx vite build`, and Vite transpiles
without type checking, so a type error survives the bundle step. CI runs the
check explicitly (`.github/workflows/test.yml`), and so does
`scripts/release-check.sh`. Measured 2026-09-24: `npm run typecheck` is
`tsc --noEmit`, needs nothing from JSR, exit 0.

**`build-node.sh` last, because it consumes what the others produce.** It ends
with an unconditional `cp -r src/ui/dist bin/ui-dist`, and `src/ui/dist/` is
gitignored, so on the fresh clone this page is written for the script runs all
the way to its last line and then dies: measured 2026-09-24, exit 1,
`cp: src/ui/dist: No such file or directory`. It needs nothing from JSR
otherwise - it takes `@casys/mcp-server` from npm, because it builds the npm
package - and the full sequence exits 0 on a blocked machine, writing
`dist-node/bin`.

**The repeated `deno test`, because §4 ran too early to mean anything.** See the
warning in §4: until `src/ui/dist/` exists, the bundle test passes without
testing. Re-running that one file afterwards is cheap and closes the hole.

Publishing is not affected either. `.github/workflows/publish.yml` runs on a
published release; its `publish-jsr` job is gated on the repository variable
`PUBLISH_JSR` and skips while that is unset, so only npm ships today. If JSR
publishing is ever enabled, it will run on a GitHub runner and will not see this
`403`.
