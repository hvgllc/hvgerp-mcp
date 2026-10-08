# MCP Events for calendar meetings

MCP Events lets an MCP client subscribe to calendar meeting changes. The server
delivers small signed webhook events (a pointer, never the meeting content) and
the client re-reads the meeting with `erpnext_meeting_get` under its own
permissions. The feature is **off by default**.

Contract file: `src/events/contract/meeting-events.v1.json`

SHA-256 of the contract file:
`085a2085ee8b858dbb4843cd8631cde452769d67344bfb771a93875bb22d940e`

A test (`src/events/contract_test.ts`) fails when this value and the file
disagree, so the ERP side and this server can confirm they hold the same
contract by comparing the hash.

## What this server does and does not do

- It adds three JSON-RPC methods on the existing `POST /mcp` endpoint:
  `events/list`, `events/subscribe`, `events/unsubscribe`. Discovery
  (`server/discover`, `initialize`) keeps every existing capability and adds
  `capabilities.events` only for a request that carries a verified user
  identity.
- It stores **nothing**: no secret, token, callback URL, cursor or subscription.
  Durable state and webhook delivery live in ERPNext (`hvg_workspace`). There is
  no worker and no database here.
- Each call to ERPNext uses the request's own bearer token, sent as
  `Authorization: HVGKeycloak <token>`, so ERPNext verifies the user again and
  applies that user's permissions.
- It never logs a token, secret, callback path or query, meeting title or email.
  Log lines carry only the method name and the error code.
- It never executes or interprets task text from a payload, and it does not
  touch Project, HD Ticket or Task data.

## Enabling

```bash
MCP_EVENTS_ENABLED=1 \
MCP_CALLER_IDENTITY=required \
MCP_OAUTH_JWKS_URL=... MCP_OAUTH_AUDIENCE=... MCP_OAUTH_ISSUER=... MCP_AUTH_RESOURCE=... \
deno run ... server.ts --http
```

`MCP_EVENTS_ENABLED` accepts `1/true/yes/on` and `0/false/no/off`; unset means
off; any other value stops startup. When on, startup is refused unless:

1. `--http` is used (Events do not exist over stdio);
2. `MCP_CALLER_IDENTITY` resolves to `required` (so `ERPNEXT_API_KEY` and
   `ERPNEXT_API_SECRET` must be unset);
3. OAuth JWT verification is configured (`MCP_OAUTH_JWKS_URL`).

Static bearer tokens carry no user identity, and `MCP_CALLER_IDENTITY=required`
(which Events needs) refuses every `tools/call` made without one. Startup
therefore fails when `MCP_AUTH_TOKEN(S)` is set together with the Events flag:
move those clients to OAuth user tokens and remove the static tokens, or leave
Events off.

With the flag on, the HTTP listener is opened through the runtime port with the
SDK's fetch handler wrapped by the Events adapter. With the flag off the
original `startHttp` path is used unchanged, and `erpnext_meeting_get` is not
listed.

### Rollback

Unset `MCP_EVENTS_ENABLED` (or set it to `0`) and restart. The server returns to
the previous behaviour: no `events/*` methods (`-32601` as before), no
`capabilities.events`, no `erpnext_meeting_get`. Existing subscriptions are not
deleted by this server; they live in ERPNext and expire on their own TTL.

## Protocol

| Method               | Result                                                                                                                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `events/list`        | Three descriptors: `meeting.created`, `meeting.updated`, `meeting.cancelled`. They share one `payloadSchema` and one `inputSchema` (`event_id`). Only the `webhook` delivery mode is offered. |
| `events/subscribe`   | `{ id, refreshBefore, cursor, truncated }` (stamped `resultType: "complete"`).                                                                                                                |
| `events/unsubscribe` | `{}`, always, so it is idempotent. The signing secret is not accepted here.                                                                                                                   |

Every `events/*` request first passes through the SDK's own gates (rate limit,
body limit, authentication with `401` and `WWW-Authenticate`,
`MCP-Protocol-Version`, `_meta`, `Mcp-Method`). The adapter only handles a
request after the SDK has accepted it and reports the method as unknown, and it
then verifies the bearer a second time and resolves the caller identity with the
same function the tool middleware uses. An older SDK that learns `events/*`
itself makes the adapter step aside.

Subscribe notes: `refreshBefore` is always a finite timestamp. `ttlMs: null` is
only a request for no expiry; the ERP grants a finite lease capped by the
verified token, so a `null` `refresh_before` from the backend is treated as a
malformed reply. `maxAgeMs` (a non-negative integer; `0` means no history, so
any older cursor is reported as truncated) is forwarded to the ERP as
`max_age_ms`: it can only narrow the replay window of a resume cursor, never
widen it (the ERP caps replay at 24 hours by default, 7 days retained), and the
events carry only a pointer to be re-read with `erpnext_meeting_get`.
`events/unsubscribe` takes `delivery.url`; `delivery.mode` may be omitted but,
when present, must be `webhook`.

Delivery is at least once. ERPNext sends each webhook straight to the client's
callback (this server is not on that path), and a retry or a resubscribe can
deliver an event that was already delivered. A client must treat
`(event_id, revision)` as the identity of an event and ignore one it has already
handled. Re-reading with `erpnext_meeting_get` is safe to repeat, so a duplicate
only costs one extra read.

The webhook signing secret is `whsec_` followed by base64 of 24 to 64 random
bytes. It is validated and forwarded to ERPNext in the `subscribe` call; it is
never stored, logged or echoed back.

### Errors

| Code     | HTTP | Meaning                                                                                                                                                                                  |
| -------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-32020` | 400  | `Mcp-Method` / `MCP-Protocol-Version` mismatch (SDK), or a supplied `Mcp-Name` that differs from `params.name` on `events/subscribe` and `events/unsubscribe` (omitting it is accepted). |
| `-32022` | 400  | `_meta` protocol version problem (SDK).                                                                                                                                                  |
| `-32602` | 400  | Invalid params, including a malformed, non-HTTPS, credential-bearing or hostless callback URL. Names the offending field, never its value.                                               |
| `-32011` | 404  | Unknown event name.                                                                                                                                                                      |
| `-32012` | 403  | No user identity, or ERPNext refused the user.                                                                                                                                           |
| `-32013` | 429  | Subscription limit reached.                                                                                                                                                              |
| `-32014` | 400  | Unsupported delivery (`mode` is not `webhook`, or `delivery` carries an unknown key).                                                                                                    |
| `-32015` | 502  | Callback verification failed (reason from a fixed list).                                                                                                                                 |
| `-32603` | 502  | ERPNext unavailable, throttling the request (transport HTTP 429, not a subscription quota), or returned an unexpected shape; also the token verifier failing operationally.              |
| `-32603` | 503  | Too many subscribe/unsubscribe calls in flight (see below).                                                                                                                              |

ERPNext answers every method with HTTP 200 and `{ok, result}` or
`{ok:false, error}`. Only `error` is mapped to JSON-RPC, and only through fixed
messages and allowlisted `data`: raw ERPNext text is never reflected. An ERPNext
rejection of the caller token (HTTP 401) becomes HTTP 401 to the client. An
ERPNext 403 (the token is valid but the user lacks permission) becomes `-32012`
with HTTP 403.

Subscribe and unsubscribe calls to ERPNext run through an adapter-owned limiter:
at most 10 at once with up to 50 waiting (`maxConcurrent` / `maxQueued` options
of `createEventsAdapter`). It is separate from the SDK's own request limit,
which only covers the preliminary pass that finds the method unknown. Beyond the
queue the adapter answers 503 `Server busy`. The same 503 (with
`Retry-After: 1`) is returned when the pre-read budget for MCP POST bodies is
exhausted, instead of forwarding an unread request to the SDK, where an
authenticated Events call would surface as `-32601`. The budget bounds both the
bytes held (`maxPeekBytes`, 16 MiB by default) and the number of simultaneous
peeks (`maxPeeks`, 256 by default), because a tiny declared body that is never
sent costs one byte but still holds a socket until `peekTimeoutMs`. The 503
carries the base handler's CORS headers (taken from an `OPTIONS` probe that
never touches the request body) and exposes `Retry-After`, so a browser client
can read and retry it.

`events/subscribe` and `events/unsubscribe` reject unknown top-level parameters
with `-32602` (`field: "params.<key>"`) so a misspelt `arguments` cannot become
an unfiltered subscription. `_meta` is accepted, and `maxAgeMs` on subscribe is
validated and forwarded.

## ERPNext contract used

All methods are under `hvg_workspace.mcp_events.api`:

| Method        | HTTP | Arguments                                                                    |
| ------------- | ---- | ---------------------------------------------------------------------------- |
| `subscribe`   | POST | `name, arguments, delivery_url, delivery_secret, ttl_ms, cursor, max_age_ms` |
| `unsubscribe` | POST | `name, arguments, delivery_url`                                              |
| `meeting_get` | GET  | `event_id, occurrence_start?, window_start?, window_end?`                    |

`ttl_ms`, `cursor` and `max_age_ms` are left out of the call when the client did
not send them. `ttl_ms` and `cursor` are sent as `null` when the client sent
`null`; `max_age_ms` is only ever sent as a non-negative integer (`0` means no
history), because the protocol layer rejects a client `null` for it. An ERP
implementation must therefore accept `max_age_ms` as an optional keyword.

For `meeting_get`, a live (non-deleted) response always carries `recurrence` as
a recurrence object or `null`, and the occurrences it returns for an
`occurrence_start` request must overlap the calendar day of that start.

## erpnext_meeting_get

Registered only when the flag is on. Each call is a fresh GET (no cache) made as
the bearer's user. It returns the `title`, the `meeting_url`, the schedule,
recurrence, occurrences in a window and `has_more`, never a description or
participants. A deleted meeting is `{ event_id, revision, deleted: true }`. It
rejects any argument it does not declare, including `user_id`.

`title` and `meeting_url` are optional in the ERP response, so an ERP that
predates them still works and the keys are simply absent. When present, `title`
must be `null` or a string of at most 500 code points with at least one visible
base character: a letter, digit, punctuation mark or symbol that is not a
default-ignorable code point (such as U+3164) or U+2800. Whitespace, format
characters such as U+200B and lone combining marks such as U+034F or U+FE0F do
not count. `meeting_url` must be `null` or an absolute `https` URL of at most
2048 characters with no user name or password and no whitespace, control or
format characters (the link is returned verbatim, so it must already be in the
form a URL parser would keep). Anything else is a backend error. ERP sends
`null` rather than inventing a value: it reads the link from
`Event.custom_meeting_url`, falling back to `Event.google_meet_link`, and turns
a non-`https` or over-long link into `null`. Both keys sit at the meeting level,
never inside `occurrences`. The webhook payload is unchanged and still carries
no title or link.

`title` is the value at read time and is not tied to `revision`: a change of
link is a schedule-relevant change that sends `meeting.updated` and bumps the
revision, but a rename alone sends no event and keeps the revision. Do not cache
a title by revision.

## Authentication lease

The server verifies the bearer on every request and ERPNext verifies it again,
so a user whose access is removed in ERPNext is refused at once. The server
cannot revoke an OAuth token at the identity provider: a token that is still
valid for the provider keeps working until it expires, so keep access-token
lifetimes short. The webhook subscription itself is leased by ERPNext through
`refresh_before`; the client must subscribe again before that time.

## Diagnostics

- `events rpc ok method=<name>` and `events rpc refused code=<code>` on stderr,
  nothing else per request.
- `-32012` usually means the client is using a static shared bearer, or its
  token has no `email` claim. With `MCP_CALLER_IDENTITY=required` such a client
  cannot call tools either.
- `-32603` means ERPNext did not answer in the agreed shape. Check that the
  `hvg_workspace` app on the site exposes `mcp_events.api`.
- Legacy clients behind `shim.ts` keep working: a 2026-07-28 request passes
  through the shim unchanged, and a translated legacy request reaches the same
  adapter (covered by `src/events/shim_events_test.ts`).
