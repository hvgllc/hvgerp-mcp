# Changelog

All notable changes to `@hvgllc/hvgerp-mcp` will be documented in this file.

This package is a fork of
[`@casys/mcp-erpnext`](https://github.com/Casys-AI/mcp-erpnext), renamed at
3.0.0. Every entry below 3.0.0 is that project's history, and its links
deliberately still point at the upstream repository, where those commits, pull
requests and tags actually live.

## [Unreleased]

### Added

- **`erpnext_doctype_fields`** (new `discovery` category). Returns the real
  field schema of a DocType: fieldname, label, fieldtype, link target,
  mandatory, read-only, permlevel and description, plus whether the doctype is
  single, a child table, submittable or a tree. Before this, a model that needed
  to filter or write a field had one way to learn the schema - fetch a sample
  document and look at the keys it happened to carry - which silently misses
  every field left null on that row and reports no labels, types or link
  targets. The Frappe metadata endpoint behind it performs no permission check
  of its own, so the tool asks ERPNext first through
  `frappe.client.has_permission` and refuses when the caller cannot read the
  doctype.
- **`erpnext_calendar_events`.** Lists Events over a date range through the same
  call the ERPNext calendar uses, so a repeating event is expanded into one row
  per occurrence, each tagged with `recurring_from`. `erpnext_doc_list` on
  `Event` returns the single stored row instead, which turns a weekly stand-up
  into zero or one meeting for the week. The tool description states the scope
  it actually covers - open events that are Public, owned by the caller, or
  shared with them - so an answer is not presented as a complete personal
  schedule.
- **`erpnext_account_list` filters on `disabled`** and returns the field, so
  "how many accounts are active" is a direct question rather than an inference.

### Fixed

- **`count` in every list result is the total, not the page size.** All 42 list
  tools returned `count: docs.length`, while the doclist viewer renders it as
  `{shown} of {count} records`. A 97-row chart of accounts therefore reported
  "50 of 50 records" under the default limit, and a model reading that answered
  "50 accounts". Results now carry `count` (total matching documents),
  `returned` (rows in this page) and `has_more`. The total comes from
  `frappe.client.get_count`, which runs through the same permissions as the
  list, and is only requested when the page came back full - a short page
  already proves the total.

## [3.2.0] - 2026-08-17

### Added

- **Identity tools.** `erpnext_whoami` reports who the server believes the
  caller is (User id, full name, roles, matching `Employee`, and
  `identity_mode`), and `erpnext_my_work` rolls up that person's open ToDos,
  tasks, leave applications, expense claims and timesheets. Without them a
  first-person question had no subject: the model had no way to turn "my tasks"
  into a User id, and answered for whoever the connection happened to
  authenticate as.
- **`me` is understood by user-typed inputs.** `me`, `@me`, `self` and `@self`
  resolve to the caller's own `User` (or `Employee`, where the field is
  employee-typed) across the task, timesheet, leave, expense, CRM and kanban
  tools, instead of reaching Frappe as a literal string that matches nobody.
- **`erpnext_whoami` is loaded under every category filter.** The server
  instructions tell the model to call it before any first-person request, so
  `--categories=project` used to leave that instruction pointing at a tool
  absent from `tools/list`. Exactly that one tool is added - not the rest of the
  `identity` category, whose `erpnext_my_work` reads four doctypes outside the
  requested surface.

### Fixed

- **`erpnext_whoami` no longer reports withheld roles as no roles.**
  `User.roles` is a permlevel-1 field on stock ERPNext, readable only by
  `System Manager`, so every ordinary employee asking about themselves was told
  `roles: []` - a fabricated answer about the majority of real callers.
  - Frappe does not omit a withheld permlevel-1 field, it **empties** it:
    measured on production against a caller holding three roles, `roles` came
    back as `[]` with the key present. So the list alone cannot distinguish "you
    hold none" from "I will not say", and an earlier attempt to read an absent
    key was inert.
  - The discriminator is `user_type`, which sits at the same permlevel and is
    never legitimately empty (it defaults to `System User`; no `User` row on
    this deployment has it unset). A null `user_type` beside an empty `roles`
    means permlevel 1 was withheld wholesale, and `roles` is reported as `null`
    with a `roles_note` explaining it. `[]` now means the user genuinely holds
    none.
  - Their real ceiling is unaffected either way - ERPNext enforces it per call,
    not from this list.
- **`erpnext_whoami` no longer fails for a caller who may not read `Employee`.**
  The profile lookup treated the HR record as part of the identity, so a `403`
  on that side query took the whole call down - and the server instructions tell
  every client to call `erpnext_whoami` _first_, which is precisely where there
  is nothing to fall back on. A permission refusal is now recorded instead of
  raised. Measured on production against a System User holding read on exactly
  one doctype.
  - New `employee_lookup` field on the profile and on both identity tools:
    `found` | `none` | `forbidden`. `none` and `forbidden` both leave `employee`
    null, and collapsing them would have the server state a fact it never
    established - telling someone "you have no HR record" when the truth is "I
    was not allowed to look" sends them after the wrong problem.
  - `erpnext_my_work` reports the same distinction in `skipped_sections.reason`,
    and `resolveSelfEmployee` (the `me` → employee hop) raises two different
    messages, because "ask HR to create a record" and "ask an administrator for
    the permission" are opposite next moves.
  - Only `403` is absorbed. A `5xx`, a timeout or a network error still
    propagates: those mean the reply would be unreliable rather than incomplete,
    and answering "no HR record" for one of them would be a guess dressed as a
    finding.
- **`identity_mode` is read off the client that serves the request**, not off
  the presence of a caller context. An embedding application can install a
  static client with `setFrappeClient()` and still run inside `runWithCaller()`;
  the old check labelled that `per-caller` and `erpnext_whoami` swallowed the
  one warning it exists to raise.
- **`erpnext_my_work` only absorbs a permission refusal.** A section that fails
  with `5xx`, a timeout or a network error now propagates instead of being
  reported as an inaccessible doctype. Those mean the roll-up is untrustworthy
  rather than incomplete, and burying them left the client no signal to retry
  while the model read "no work" for "could not read".
- **Unassigning by email no longer costs a `User` read.** A Frappe `User` id is
  the email, so the lookup could not change the outcome - but ordinary employees
  may not read `User`, so it turned into a `403` on an operation they were
  allowed to perform. `erpnext_doc_assign` already worked this way;
  `erpnext_doc_unassign` now matches it.
- **The caller profile cache is partitioned per `FrappeClient`.** Two callers
  sharing a cache entry meant whoever asked first decided what the next one was
  told about themselves.

## [3.1.0] - 2026-08-16

### Added

- **Per-caller identity over HTTP.** A tool call can now act as the user who
  made it instead of under one shared ERPNext service account. The caller's
  verified access token is forwarded to Frappe as
  `Authorization: HVGKeycloak <token>`, so Frappe resolves the identity itself
  and applies that user's roles and row-level permissions.
  - `MCP_CALLER_IDENTITY` = `required` | `optional` | `off`. The default is
    conditional: `required` when no `ERPNEXT_API_KEY`/`ERPNEXT_API_SECRET` are
    set, `off` when they are, so existing HTTP deployments keep their behaviour
    on upgrade.
  - The identity comes from the verified token's `email` claim (falling back to
    `preferred_username` only when it is an email). `sub` is deliberately not
    accepted: it maps to no ERPNext user, and failing here is better than
    failing silently at the ERPNext boundary.
  - Each caller gets its own `FrappeClient` **and its own read cache**. Sharing
    the process-wide cache would let whoever queried first decide what the next
    caller sees, which is a data leak rather than a cache hit.
  - `cache.scope` on the MCP app flips to `private`, and the startup cache warm
    is skipped under `required` — it runs outside any request, so there is no
    user to warm it as.
  - New exports: `runWithCaller`, `currentCaller`, `callerPrincipal`,
    `createCallerIdentityMiddleware`, `resolveCallerIdentityMode`.

### Changed

- `FrappeClientConfig.apiKey`/`apiSecret` are optional; a new
  `authHeader?: () =>
  string` takes precedence and is resolved **per
  request**, so a refreshed access token reaches the wire instead of a value
  frozen at construction time. A client built with neither now throws rather
  than issuing an unauthenticated request, which Frappe answers as Guest — an
  empty result that reads like "no data" instead of like a failure.

## [3.0.3] - 2026-08-16

### Fixed

- stdio transport: also stamp `ttlMs` and `cacheScope` (SEP-2549
  `CacheableResult` envelope) onto `tools/list`, `resources/list`,
  `resources/templates/list`, `resources/read`, and `prompts/list` responses
  that lack them, mirroring the same gap `resultType` had in 3.0.2 and fixed the
  same way: `@casys/mcp-server` correctly withholds both fields on stdio per
  spec (they only apply once a peer negotiates `2026-07-28`), but Claude Code's
  MCP client requires them regardless of the negotiated revision. The shim now
  tracks each request's method (via a passive `stdin` listener) so it only adds
  cache hints to the methods the spec actually applies them to, using the same
  values the server would emit under stateless/HTTP transport
  (`ttlMs: 3_600_000`, `cacheScope: "public"`). See
  `src/claude-code-stdio-compat.ts`.

## [3.0.2] - 2026-08-16

### Fixed

- stdio transport: stamp `resultType: "complete"` onto `tools/list`,
  `resources/list`, and `prompts/list` responses that lack it. Claude Code's MCP
  client currently requires this field even at the 2025-11-25 protocol revision
  stdio negotiates, where the spec defines a missing `resultType` as
  `"complete"` — a bridge Claude Code's own error message names but does not
  honor. `@casys/mcp-server` correctly omits the field there per spec; this
  patches the wire format after serialization so Claude Code connects, without
  changing the SDK's spec-correct behavior. See
  `src/claude-code-stdio-compat.ts`.

## [3.0.1] - 2026-08-08

### Changed

- use `@casys/mcp-server` `^0.25.0`, which brings four 2026-07-28 conformance
  fixes: `server/discover` over stdio, argument validation on JSON Schema
  2020-12 (draft-07 silently ignored `prefixItems` and the other 2020-12
  keywords), W3C trace-context propagation, and client credentials bound to the
  authorization server that issued them.

  None of that release's breaking changes affect this server: it does not use
  the OAuth client, no tool schema uses the draft-07 tuple form, and no test
  asserts on the method-not-found message.

## [3.0.0] - 2026-07-31

### ⚠ BREAKING CHANGES

- **Renamed to `@hvgllc/hvgerp-mcp`.** The package, the server name reported to
  MCP clients, the log prefix, and the compiled binary are all `hvgerp-mcp` now.
  Three things break for an existing install: the install command
  (`npx @hvgllc/hvgerp-mcp`, `jsr:@hvgllc/hvgerp-mcp`), the Node bundle path
  (`dist-node/bin/hvgerp-mcp.mjs`), and the UI resource URIs, which moved from
  `ui://mcp-erpnext/{viewer}` to `ui://hvgerp-mcp/{viewer}` — a host holding a
  cached resource list must re-read it. Tool names are untouched: every tool is
  still `erpnext_*`, so no client tool configuration changes.

- **HTTP transport is stateless in the unreleased code.** Every HTTP request
  must carry `MCP-Protocol-Version: 2026-07-28`, the matching `Mcp-Method`, and
  `params._meta["io.modelcontextprotocol/protocolVersion"]` plus an
  object-valued `clientCapabilities`. A client that omits required protocol
  fields is rejected on every call, including `initialize`. Clients built
  against MCP spec 2025-06-18 send no such field — notably the official
  TypeScript SDK v1 line, whose HTTP transport never emits it. `GET /mcp`
  returns 405; no `Mcp-Session-Id` is issued.

  **stdio clients are unaffected** — the stateless mode gates only the HTTP
  handler. If you connect via `command`/`args`, nothing changes for you.

  Users who need the previous behaviour should stay on the 2.x line. See
  [docs/migration-mcp-spec-2026-07-28.md](docs/migration-mcp-spec-2026-07-28.md).

### Features

- add `erpnext_method_call`, which invokes a whitelisted Frappe method by its
  dotted path. It reaches business endpoints no typed tool wraps, including the
  custom-app methods that are sometimes the only supported way to change a field
  the document API refuses to write. Calls run as the API key's own ERPNext
  user; `ERPNEXT_METHOD_ALLOWLIST` (exact paths, `prefix.*` patterns, or `*`)
  optionally narrows the tool below that. Pass `http_method: "GET"` for methods
  whitelisted read-only, and `invalidate` to drop a cached document the call
  mutated
- use `@casys/mcp-server` `^0.24` and the complete MCP 2026-07-28 HTTP contract:
  `server/discover`, routing headers, complete result envelopes, and public
  one-hour cache hints for discovery/list/read responses
- offer opt-in signed MRTR link disambiguation where configured with
  `MCP_MRTR_SIGNING_KEY` (exactly 64 lowercase hexadecimal characters); without
  a key or client elicitation, the explicit ambiguity error remains
- do not advertise Tasks: no handler is demonstrated long-running enough and
  framework task storage is process-local; `subscriptions/listen` exists in the
  framework, but ERPNext notifications are not emitted

### Bug Fixes

- **write paths:** resolve supplier and employee names on create handlers —
  `erpnext_purchase_order_create`, `erpnext_leave_application_create` and
  `erpnext_expense_claim_create` required an opaque Frappe ID while their
  `_list` counterparts already accepted human-readable names, so an agent given
  a display name could not succeed at all
- **hr:** `erpnext_employee_get` now resolves a name, honouring the description
  it advertises
- **analytics:** issue independent Frappe queries concurrently in
  `erpnext_sales_funnel`, `erpnext_gross_profit`, `erpnext_profit_loss` and
  `erpnext_product_radar` — one round-trip instead of up to four
- **analytics:** bound `erpnext_product_radar` input to 8 items; the fan-out is
  one Bin query per item

## [2.6.0](https://github.com/Casys-AI/mcp-erpnext/compare/v2.5.0...v2.6.0) (2026-07-23)

### Features

- **HTTP authentication and Docker deployment** — HTTP deployments can now opt
  into static bearer-token authentication (`MCP_AUTH_TOKEN` / `MCP_AUTH_TOKENS`)
  or OAuth JWT validation through a JWKS endpoint, with protected-resource
  metadata for MCP clients. Dockerfile, Compose example, and deployment docs are
  included; existing unauthenticated HTTP and stdio setups remain compatible
  when no auth is configured. Thanks
  [@notnotkeshav](https://github.com/notnotkeshav)
  ([#8](https://github.com/Casys-AI/mcp-erpnext/pull/8)).
- **`erpnext_file_upload`** attaches base64-supplied bytes to any DocType as a
  native Frappe `File`, optionally filling an Attach/Attach Image field. Uploads
  are private by default and have a configurable decoded-size limit. Tool count
  123 → 124. Thanks [@mateotiedra](https://github.com/mateotiedra)
  ([#14](https://github.com/Casys-AI/mcp-erpnext/pull/14)).

### Bug Fixes

- **submit:** Fresh ERPNext instances with null rounded totals no longer fail
  submission; transactional submit tools automatically disable unconfigured
  rounding and return a warning when this fallback is used. Thanks
  [@notnotkeshav](https://github.com/notnotkeshav)
  ([#13](https://github.com/Casys-AI/mcp-erpnext/pull/13)).

### Documentation

- Add a Traditional Chinese README.

## [2.5.0](https://github.com/Casys-AI/mcp-erpnext/compare/v2.4.2...v2.5.0) (2026-07-21)

### Features

- **Human-readable link filters** — tools filtering on a Link field (employee,
  customer, supplier, item, plus dynamic-link fields like Payment Entry's
  `party` or Quotation's `party_name`) now accept a name/email, not just the
  document ID, and resolve it server-side in the same call — no more
  list-then-filter round trip. Ambiguous matches surface the candidate list
  instead of silently guessing, and write paths never fuzzy-match. Thanks
  [@notnotkeshav](https://github.com/notnotkeshav) (#9).
- **Date-range filters** — `date_from`/`date_to` added to 10 list tools that
  lacked them (timesheet, project, task, leave application, payroll entry,
  expense claim, asset, campaign, quotation, supplier quotation). Thanks
  [@notnotkeshav](https://github.com/notnotkeshav) (#7).
- **Pluggable cache layer** — `FrappeClient.list()`/`.get()` are cached through
  a pluggable `Cache` (in-process `MemoryCache` by default, `NoopCache` to
  disable), with automatic invalidation on create/update/delete/submit/cancel
  and optional startup warming. Config: `MCP_CACHE_ENABLED`, `MCP_CACHE_TTL_MS`,
  `MCP_CACHE_WARM_TOOLS`. Thanks
  [@notnotkeshav](https://github.com/notnotkeshav) (#6).

## [2.4.2](https://github.com/Casys-AI/mcp-erpnext/compare/v2.4.1...v2.4.2) (2026-07-21)

### Bug Fixes

- **http:** HTTP mode (`--http`) now binds to `127.0.0.1` by default instead of
  `0.0.0.0`. The server — and every tool, which acts with the server's ERPNext
  API key — is no longer reachable from the whole network unless exposure is
  explicitly opted into via `--hostname=0.0.0.0`, matching MCP security best
  practice. A startup warning is printed when binding to a non-loopback
  interface. Docker deployments must pass `--hostname=0.0.0.0` in the container
  command. Thanks @notnotkeshav for surfacing the exposure gap (#8, #10).

## [2.4.1](https://github.com/Casys-AI/mcp-erpnext/compare/v2.4.0...v2.4.1) (2026-07-16)

### Features

- **`erpnext_doc_unassign`** removes one user's native assignment on any DocType
  via `frappe.desk.form.assign_to.remove` (closes the ToDo, resyncs `_assign`)
  and returns the remaining open assignments. Idempotent on the Frappe side.
  Tool count 122 → 123.
- **kanban-viewer:** per-assignee unassign (×) button in the detail modal, with
  busy/error states.

### Bug Fixes

- **kanban-viewer:** Frappe v16 omits `_assign` from single-doc GET responses —
  the detail modal now rebuilds it from the authoritative assignment result
  (assign and unassign), and treats an explicit empty `_assign` as truly
  unassigned so a just-removed assignee no longer reappears.

## [2.4.0](https://github.com/Casys-AI/mcp-erpnext/compare/v2.3.1...v2.4.0) (2026-07-16)

### Bug Fixes

- **npm/HTTP:** `npx @casys/mcp-erpnext --http` no longer crashes on Node.js
  with `ReferenceError: Deno is not defined`. The npm bundle now consumes
  `@casys/mcp-server`'s own npm build (Node-clean) instead of re-bundling its
  Deno/JSR source, and both packages select their runtime adapter at load time
  instead of a build-time file swap. `build-node.sh` fails fast if the resolved
  `@casys/mcp-server` predates 0.21.1 (first Node-clean release). Thanks
  [@dennypradipta](https://github.com/dennypradipta) for the report and the
  workaround docs ([#4](https://github.com/Casys-AI/mcp-erpnext/pull/4)).

### Features

- **native Frappe assignment across doctypes.** `erpnext_doc_assign` assigns any
  document via `frappe.desk.form.assign_to.add` (permissions, ToDo, realtime
  notifications, and assignment emails preserved), with assignee validation and
  native ToDo IDs in the response. `erpnext_user_list` lists enabled users. The
  kanban detail modal gains an assignee section with a user dropdown
  ([#5](https://github.com/Casys-AI/mcp-erpnext/pull/5)). Based on
  [@mateotiedra](https://github.com/mateotiedra)'s Task-assignment
  implementation ([#3](https://github.com/Casys-AI/mcp-erpnext/pull/3)) — thanks
  Mateo!
- migrate to `@casys/mcp-server` ^0.21 and the `McpApp` API (the deprecated
  `ConcurrentMCPServer` alias is no longer used); audited the deprecated
  Sampling / Logging / Roots capabilities — none used (migration plan §1–2).

## [2.3.1](https://github.com/Casys-AI/mcp-erpnext/compare/v2.3.0...v2.3.1) (2026-05-29)

### Bug Fixes

- **analytics:** `erpnext_stock_chart` no longer fails (HTTP 417) when filtering
  by `item_group`. `Bin` has no `item_group` field, so the group is resolved to
  item codes via `Item` and filtered in memory.

### Documentation

- **readme:** add status badges (JSR, npm, CI, MCP, license) and a Screenshots
  gallery of the 7 interactive viewers.
- add community health files: `SECURITY.md`, `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md`, issue forms, and a pull request template.
- **roadmap:** add the "NEXT — Platform integration" milestone (MCP bridge,
  ERP-agnostic core, Zitadel OIDC auth).

## [2.3.0](https://github.com/Casys-AI/mcp-erpnext/compare/v2.2.2...v2.3.0) (2026-05-14)

### Features

- add missing tests and doclist-viewer component re-exports
  ([a5f714f](https://github.com/Casys-AI/mcp-erpnext/commit/a5f714fbdc5e2234635f2626fcca615704e965cd))
- add ToolAnnotations (readOnlyHint, destructiveHint) to all tools
  ([386e28b](https://github.com/Casys-AI/mcp-erpnext/commit/386e28b9b687f3e99e0593878cdf51abf7a112e0))
- **chart-viewer:** add data point click drill-down and fix currency
  ([09b3519](https://github.com/Casys-AI/mcp-erpnext/commit/09b35194ff88b91bc0ba6f708efa8e461cc12824))
- **doclist-viewer:** add inline detail, row actions, sendMessage, chip filters
  ([121a723](https://github.com/Casys-AI/mcp-erpnext/commit/121a723edc071e40939b896c5d325171e636731c))
- **frappe-client:** retry transient reads
  ([699ecdf](https://github.com/Casys-AI/mcp-erpnext/commit/699ecdf3848e219a8a1a5f093031895d62d63a8a))
- **funnel-viewer:** add stage click drill-down via sendMessage
  ([ea7612e](https://github.com/Casys-AI/mcp-erpnext/commit/ea7612e9620c976501e6f4ba1bc350dfa82524e1))
- **funnel-viewer:** redesign with trapezoid clip-path, gradients, and action
  buttons
  ([2b0bc1d](https://github.com/Casys-AI/mcp-erpnext/commit/2b0bc1ddcd7ba9e5d7826ae80f11ea792823930b))
- **invoice-viewer:** add item drill-down, actions, sendMessage navigation
  ([ac44542](https://github.com/Casys-AI/mcp-erpnext/commit/ac44542da1baae63106b1a46c4bcb4e3d80688b4))
- **kanban-viewer:** replace fire-and-forget actions with sendMessage
  ([cc4e43b](https://github.com/Casys-AI/mcp-erpnext/commit/cc4e43bc3c80b03c7182db82658e109fc3a5df89))
- **kanban:** enrich card fields for all three doctypes
  ([4bfbfdd](https://github.com/Casys-AI/mcp-erpnext/commit/4bfbfdd30d7bd40f98f0668263a071e60ec263f0))
- **kanban:** enrich cards, add detail modal, and improve tab navigation
  ([0638ce1](https://github.com/Casys-AI/mcp-erpnext/commit/0638ce185457347f7571796c2e6ad46d78fde43a))
- **kanban:** enrich cards, detail modal, and tab navigation
  ([cb4a938](https://github.com/Casys-AI/mcp-erpnext/commit/cb4a938be4d787de1c69e241077a70580b819414))
- **kanban:** integrate column focus layout for narrow viewports
  ([efbf288](https://github.com/Casys-AI/mcp-erpnext/commit/efbf288274c546606f86200b0cb5ed5a0375aacf))
- **kanban:** proper form controls for each field type in detail modal
  ([2f0bd39](https://github.com/Casys-AI/mcp-erpnext/commit/2f0bd39a8d015c1db71e77b3f9de9565ed8ce887))
- **kanban:** redesign cards, branding, and focus mode UX
  ([4bf5f20](https://github.com/Casys-AI/mcp-erpnext/commit/4bf5f20ed695d9eb09d484240d3c1b581ebb94d4))
- **kanban:** redesign detail modal with Jira-style layout
  ([2c52adf](https://github.com/Casys-AI/mcp-erpnext/commit/2c52adf6f5c8cd8c6383f17d0e99196a68c44a68))
- **kanban:** redesign detail modal with polished form layout
  ([c083487](https://github.com/Casys-AI/mcp-erpnext/commit/c0834876f23bf1bfdbb5a27ae6832387dde07ec5))
- **kpi-viewer:** add drill-down on big number and sparkline click
  ([6e771d0](https://github.com/Casys-AI/mcp-erpnext/commit/6e771d0aaab7ed2465a24808aefeb36cc1d92224))
- **stock-viewer:** add stock detail panel with item info and sendMessage
  ([932e894](https://github.com/Casys-AI/mcp-erpnext/commit/932e894cc5ad21cca001a4524d71c2c3c9138ff9))

### Bug Fixes

- add missing items schema for filters array (closes
  [#2](https://github.com/Casys-AI/mcp-erpnext/issues/2))
  ([40b865f](https://github.com/Casys-AI/mcp-erpnext/commit/40b865fd85cf680abf2b3cb7c217876c2f1ca10b))
- **doclist-viewer:** cap visible columns at 6, prioritize key fields
  ([37b80bc](https://github.com/Casys-AI/mcp-erpnext/commit/37b80bc3b7d8ab1d7e3f17584328acc5ff31281b))
- **funnel-viewer:** replace height:100vh with minHeight to prevent content
  clipping
  ([76e7d9a](https://github.com/Casys-AI/mcp-erpnext/commit/76e7d9ada4bfcbac4f7440fb437f69154d46a95e))
- iframe infinite resize in all viewers and remove invalid Lead source field
  ([25e443e](https://github.com/Casys-AI/mcp-erpnext/commit/25e443e5560d4c95d27b6cdd4353a240ee158b8e))
- import ToolAnnotations from @casys/mcp-server, add structuredContent tests
  ([98d2eb1](https://github.com/Casys-AI/mcp-erpnext/commit/98d2eb1fc43ae226e49a7d91d4f56bc8fce65221))
- **kanban-viewer:** guard detail save tool calls
  ([b8777d9](https://github.com/Casys-AI/mcp-erpnext/commit/b8777d9a9bbd3b49c9242cca1e2b4a6742026785))
- **kanban-viewer:** use shared extractToolResultText for structuredContent
  support
  ([a66f97b](https://github.com/Casys-AI/mcp-erpnext/commit/a66f97b3530eb57c8ba03b39b5524abc7727e61e))
- **kanban:** bump min-height to 600px for better modal display
  ([c591eb1](https://github.com/Casys-AI/mcp-erpnext/commit/c591eb173621b6e4e3002d6de6e9ceaf8dae08bc))
- **kanban:** redesign detail modal and fix save
  ([b829df9](https://github.com/Casys-AI/mcp-erpnext/commit/b829df9b0dc83285a5ff84f98cc20cb76b2eae43))
- **kanban:** remove stale capabilities gate blocking save and actions
  ([b10d35b](https://github.com/Casys-AI/mcp-erpnext/commit/b10d35b264ade49d3cbd0f9d6e33059dda6861c0))
- **kanban:** set min-height 480px so detail modal has room to display
  ([c348cb6](https://github.com/Casys-AI/mcp-erpnext/commit/c348cb6c579f7d89759df62c9025183e8b791d22))
- **kanban:** unwrap doc_get data envelope and fix modal action buttons
  ([b67bf0f](https://github.com/Casys-AI/mcp-erpnext/commit/b67bf0f2aa338d7f02eed35af6e7498c3d66aead))
- pin @casys/mcp-server version constraint for JSR publish
  ([2782e80](https://github.com/Casys-AI/mcp-erpnext/commit/2782e80a5362602704d7468129b3fecbf481eff7))
- remove uiMeta() import from viewer-meta (mcp-compose not on npm)
  ([89d20ff](https://github.com/Casys-AI/mcp-erpnext/commit/89d20ff1a40b344bf9cf14e01fcd9d439b203625))
- structuredContent for all viewer tools + dead code cleanup
  ([b9ab6cc](https://github.com/Casys-AI/mcp-erpnext/commit/b9ab6ccebd2c4f4d18c316cac1c480fdbf9c1b64))
- surface Frappe error messages instead of generic "Tool execution failed"
  ([b4ef624](https://github.com/Casys-AI/mcp-erpnext/commit/b4ef624818ed8f70a1827ccd4382c04ac58c9c3a))
- update build-node.sh to use @casys/mcp-server@^0.12.0
  ([525a084](https://github.com/Casys-AI/mcp-erpnext/commit/525a084aebcac29bfbfae6820f2262564d8231e9))
- use npx jsr add for Node build to resolve JSR transitive deps
  ([fcbaa38](https://github.com/Casys-AI/mcp-erpnext/commit/fcbaa382858e8c15c84021817eb2e970e0b262a6))

### Refactoring

- colocate tests with source files (Deno convention)
  ([35643e9](https://github.com/Casys-AI/mcp-erpnext/commit/35643e9a3622f9fa67c5544ba0d027535dead5cb))
- replace 91 inline _meta with shared viewer-meta constants
  ([076ecba](https://github.com/Casys-AI/mcp-erpnext/commit/076ecba75e499eab5aee8a0004a5303da847ee2e))
- replace 91 inline _meta with shared viewer-meta constants via uiMeta()
  ([dff32fa](https://github.com/Casys-AI/mcp-erpnext/commit/dff32faaeb2ff93923599d40540247a4ce6a1031))
- **sales:** dedupe line item mapping
  ([22774bb](https://github.com/Casys-AI/mcp-erpnext/commit/22774bbc5cf6351327b4f3281c5806c7f528453e))
- use toolErrorMapper and widen tool types for annotations
  ([db4b4ba](https://github.com/Casys-AI/mcp-erpnext/commit/db4b4ba44097c0085e697ae1c2b64744555239de))
- use uiMeta() from @casys/mcp-server in viewer-meta constants
  ([428bb52](https://github.com/Casys-AI/mcp-erpnext/commit/428bb52812ef0d6c9822e2b3c92837de51e3ca0c))

### Documentation

- add v2.1.0 changelog
  ([15527fc](https://github.com/Casys-AI/mcp-erpnext/commit/15527fcd81843a8190e216d86f62e6937ecf589a))
- clarify release workflow
  ([9c3bf88](https://github.com/Casys-AI/mcp-erpnext/commit/9c3bf88796de68f08e2afafbf51fc386eb7a03a8))
- condense README tools section, add docs/tools.md full reference
  ([b109860](https://github.com/Casys-AI/mcp-erpnext/commit/b1098603d60a1f19548299f987f354fa356b582f))
- document ERPNext Cloud compatibility and update env vars
  ([38e9ba0](https://github.com/Casys-AI/mcp-erpnext/commit/38e9ba019cdaae5f71d2fb23ed67adeedfcc5b96))
- mark P0 and P1 refactoring as done in refacto plan
  ([78e57b9](https://github.com/Casys-AI/mcp-erpnext/commit/78e57b98d439f960c8a2a8df1c66936eace543da))
- move project guidelines to AGENTS.md, add versioning conventions
  ([b322a5b](https://github.com/Casys-AI/mcp-erpnext/commit/b322a5b8af90b6c5d4a094040a151da6665861de))
- normalize project documentation
  ([a9184fe](https://github.com/Casys-AI/mcp-erpnext/commit/a9184feb9937c858343c39673567f5e065804245))
- update ROADMAP with TIER 1b cross-viewer navigation (all 7 viewers done)
  ([995a0f1](https://github.com/Casys-AI/mcp-erpnext/commit/995a0f11f8e5ffb5a1a5692d9aee979d4960764c))
- wrap Claude entrypoint
  ([377947c](https://github.com/Casys-AI/mcp-erpnext/commit/377947cc42a9df716c72af1199dfb3369c2b7f85))

## [2.1.0] - 2026-03-23

### Added

- **Cross-viewer navigation** — all 7 viewers now support `sendMessage` for
  drill-down into related documents. Click a row, item, data point, or KPI to
  navigate to another viewer.
- **Inline detail panels** — `doclist-viewer`, `invoice-viewer`, and
  `stock-viewer` expand rows to show full document details with action buttons
  (Submit, Cancel, Payments).
- **Chip filters** — `doclist-viewer` auto-detects status/category columns and
  renders clickable filter chips.
- **Interactive charts** — click bar/pie/line/area data points in `chart-viewer`
  to drill into underlying documents via `sendMessage`.
- **KPI drill-down** — click the big number or sparkline in `kpi-viewer` for
  exception lists or trend charts.
- **Funnel redesign** — trapezoid stages with CSS clip-path, gradient fills,
  ambient glow on hover, conversion badges with colored arrows, and
  click-through navigation.
- **structuredContent** — viewer tools return both `content` (JSON text for LLM)
  and `structuredContent` (data object for MCP Apps viewers). Viewers prefer
  `structuredContent` with fallback.
- **ToolAnnotations** — 95 tools annotated with `readOnlyHint`
  (list/get/analytics) and `destructiveHint` (submit/cancel/delete).
- **Shared components** — `ActionButton` (confirm pattern) and `InfoField`
  (key-value display) in `~/shared/` for reuse across viewers.
- **VS Code Copilot config** — `.vscode/mcp.json` example added to README.
- **ERPNext Cloud docs** — documented compatibility with Frappe Cloud /
  erpnext.com instances.
- **`docs/tools.md`** — full tool reference moved out of README for readability.

### Changed

- **@casys/mcp-server upgraded to 0.12.0** — uses `toolErrorMapper`,
  `MCPToolMeta`, `uiMeta()`, `ToolAnnotations` from the framework.
- **`viewer-meta.ts`** — single source of truth for viewer URIs using `uiMeta()`
  from `@casys/mcp-server`. Replaces 91 inline `_meta` objects.
- **Error handling** — moved from try/catch in `buildHandlersMap()` to
  `toolErrorMapper` in server config. Frappe API errors are surfaced with full
  detail.
- **Doclist column cap** — max 6 visible columns (prioritized: name, status,
  customer, grand_total, dates). Extra fields visible in detail panel.
- **Invoice viewer redesign** — two-column party layout, inline dates,
  `FeedbackBanner`, action loading tracked per key, inspired by mcp-einvoice
  pattern.
- **Node build** — uses `npx jsr add` instead of npm for JSR dependency
  resolution (fixes `@casys/mcp-compose` transitive dep).
- **Tests colocated** — all 22 test files moved from `tests/` to sit next to
  their source (Deno convention).
- **README condensed** — tools section replaced with compact category table.

### Fixed

- **VS Code Copilot schema validation (#2)** — `erpnext_doc_list` filters array
  was missing inner `items` schema. Strict JSON Schema validators no longer
  reject the tool.
- **Error messages** — "Tool execution failed" replaced with actual Frappe API
  error messages (e.g. "UOM 'Nos' not found").
- **Chart currency** — `formatCurrency()` now passes `data.currency` instead of
  defaulting to USD.
- **Funnel height clipping** — replaced `height: 100vh` + `overflow: hidden`
  with `minHeight: 100vh`.
- **Race conditions** — doclist row detail fetch guards against stale responses
  when clicking rows quickly.
- **Invoice item expansion** — keyed by line index instead of `item_code` to
  handle duplicate items.
- **Kanban structuredContent** — replaced inline `extractTextContent` with
  shared `extractToolResultText` that supports `structuredContent`.

## [0.2.0] - 2026-03-20

### Added

- **Kanban card redesign** — accent-colored top strip (column color), tone-aware
  badges (error/warning/success/info/neutral with semantic colors), vertical
  metric layout with micro-caps labels, and integrated action footer with
  column-colored destination dots.
- **Column-colored move buttons** — each move action button shows a 6px colored
  dot matching the destination column's color for instant visual orientation.

### Changed

- **Column focus mode improvements** — drag-and-drop is now disabled in focus
  mode (narrow viewports ≤920px) since only one column is visible. Cards use
  button-based moves exclusively. Removed unused `onDragOver`/`onDrop` handlers
  from the focus panel.
- **Cursor affordance** — draggable cards in multi-column mode now show
  `cursor: grab` (and `grabbing` on drag).

### Fixed

- **Horizontal scroll eliminated** — added `overflow-x: hidden` on `html, body`
  and the `BoardView` root container, plus `minWidth: 0` on flex children (tabs,
  panel) to prevent content overflow in column focus mode.

## [0.1.9] - 2026-03-10

### Added

- **Canonical read-write kanban MCP App** — `kanban-viewer` is now the single
  kanban surface, backed by `erpnext_kanban_get_board` and
  `erpnext_kanban_move_card`.
- **Kanban adapters for three ERPNext DocTypes** — `Task`, `Opportunity`, and
  `Issue` now share the same normalized board contract, explicit transition
  matrices, optimistic reconciliation, and server-authoritative mutation flow.
- **Shared viewer refresh infrastructure** — server-side `refreshRequest`
  injection plus shared viewer refresh helpers now support safe revalidation for
  long-lived MCP Apps.
- **Refresh-aware passive viewers** — `doclist-viewer`, `stock-viewer`,
  `invoice-viewer`, `chart-viewer`, `kpi-viewer`, and `funnel-viewer` now
  support focus refresh and manual fallback refresh actions.
- **Packaged Node distribution fixes** — the npm/Node bundle now serves the
  packaged MCP server and embedded UI resources correctly in HTTP mode.

### Changed

- **MCP App positioning** — the library is now documented and structured around
  the first production-grade read-write ERPNext MCP App flow, rather than around
  a read-only viewer catalog.
- **Kanban scope** — what started as a `Task` validation path is now extended
  through the same architecture to `Opportunity` and `Issue`.
- **Documentation consolidation** — `README.md`, `docs/ROADMAP.md`,
  `docs/coverage.md`, and the kanban design/implementation plans now reflect the
  live server surface and current viewer/tool counts.

### Removed

- **Legacy order pipeline surface** — `order-pipeline-viewer` has been removed.
- **Legacy pipeline tools** — `erpnext_order_pipeline` and
  `erpnext_purchase_pipeline` have been removed in favor of the canonical kanban
  path.

### Fixed

- **JSR viewer packaging** — `src/ui/dist` is now included in JSR publish
  artifacts so MCP App viewers are available for JSR consumers.
- **Publish workflow safety** — npm publish now fails on real registry errors
  and only skips when the version is already published.
- **Windows packaged viewer lookup** — resource path resolution now correctly
  handles Windows file URLs for npm bundle viewer assets.
- **Server metadata version** — MCP server version metadata is aligned to
  `0.1.9`.
