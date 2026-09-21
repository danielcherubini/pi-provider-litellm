---
status: approved
done-when: An invalid_grant failure produces at most one styled chat line per prompt (short anti-retry wording), exactly one error toast + one persistent footer warning per break, ≤1 console warn per break/recovery, and recovery (next successful token exchange) clears the footer and fires an info toast — verified by the unit tests in §Tests and the manual acceptance scenario in §Acceptance.
---
# Litellm auth error surface

## Context

When the GCloud OAuth refresh token is invalid (`invalid_grant` / `invalid_rapt`), every failed prompt currently produces a verbose chat error block (full OAuth JSON, up to 4 blocks when pi's auto-retry classifies the message as transient — pi's retryability is pure string matching of `errorMessage` against a transient-pattern list, `pi-ai/dist/utils/retry.js`) plus repeated identical `console.warn` lines (the token is re-exchanged per attempt: `getGcloudToken()` per `auth.apiKey.resolve()` call + the 401 forced refresh in `stream-simple.ts`).

Research (2026-09-21, see `docs/research` session) established:

- Pi has **no API to suppress or dedupe** the per-attempt chat error block — a failed provider stream (`stopReason: "error"`) always renders as a red `Error:` line in the transcript (`dist/modes/interactive/interactive-mode.js:2732-2738`).
- Non-chat surfaces exist on `ExtensionUIContext` (`dist/core/extensions/types.d.ts:62-96`): `notify(message, "info"|"warning"|"error")` (toast, renders immediately, not in transcript), `setStatus(key, text|undefined)` (persistent keyed footer), `setWidget`, `setFooter`, `setHeader`, dialogs. `ctx.hasUI` guards non-TUI modes.
- `pi.unregisterProvider(name)` takes effect immediately (documented in `types.d.ts` docs block).
- `pi.events` is the shared EventBus (`types.d.ts:1031`); event handlers receive a **live `ctx` per event** — no stored/stale context needed.
- Auth-style error texts (401/403, `invalid_grant`, `unauthorized`) match **none** of pi's transient patterns, so a deliberately worded auth error fails fast with no auto-retry amplification.
- Community pattern for provider failures: surface out-of-chat (footer/titlebar/OS notifications on `agent_settled`, per pi#7350).

## Decisions

### Surface (option A — adopted)

One-time `notify(…, "error")` + persistent keyed `setStatus` warning + short single-line chat error. **The provider stays selectable while broken.**

- Rejected B: `unregisterProvider` while broken + re-register on recovery (breaks discoverability; the user should *see* why a model fails, and a model that disappears from `/model` is confusing — see ADR `docs/adr/0002-keep-broken-provider-selectable.md`).
- Rejected C: A + a styled one-time transcript card via `appendEntry` + `registerEntryRenderer` (transcript card duplicates the toast + footer for a deterministic condition; YAGNI).

### State machine — new `src/auth-state.ts`

Module-scoped (lives as long as the token cache, resets per pi process — fresh pi session re-enters `unknown` and re-notifies once if still broken). Wraps `getGcloudToken()`; `gcloud-token.ts` stays pure. The wrapper receives an injected token function and event emitter so it is unit-testable with no pi/fs/network.

States: `unknown → broken | valid`, `broken → valid (recovered) → broken …`

| Transition | Trigger | Event (on `pi.events`) |
|---|---|---|
| `unknown/valid → broken` | exchange fails (non-ok HTTP / OAuth error), ADC missing/unreadable, service-account-not-supported | `litellm:auth_failed { code, detail }` — **once per entry into `broken`** |
| `broken → valid` | a subsequent exchange succeeds | `litellm:auth_recovered` — once per recovery |

**Dedupe guarantee:** events fire on *state entry*, never per failed call. Repeated failures while `broken` (e.g. each user prompt) emit nothing.

**Classification** (from the OAuth error JSON / credential state):

- `error: invalid_grant` (incl. `error_subtype: invalid_rapt`) → `code: "invalid_grant"` — reauth required
- other non-ok exchange status → `code: "exchange_failed"` (+ short status in `detail`)
- ADC missing / unreadable / service account → `code: "bad_credentials"` (+ which case)

`detail` keeps raw info for the console log only — **never** into the chat line.

### Chat error line — `stream-simple.ts`

Every token-failure path in gcloud mode (exchange fails before request; 401 → fresh refresh fails; 401 again after refresh) maps to exactly one stable line:

```
litellm: Google token invalid — re-auth required: gcloud auth application-default login
```

**Wording is a control knob (verified):** the line contains no token from pi's transient-error pattern list (`429/500/502/503/504/524`, `overloaded`, `rate.?limit`, `too many requests`, `service.?unavailable`, `server.?error`, `internal.?error`, `network.*`, `connection.*`, `fetch failed`, `timeout`, `timed? out`, `terminated`, `websocket.*`, `ended without`, `stream ended before…`, `retry delay`, "retry your request" phrasings, `ResourceExhausted`), so `isRetryableAssistantError()` is false → max one chat block per prompt, no auto-retry + backoff amplification.

**Carve-out:** non-auth (transient proxy) errors — e.g. a real 502 from LiteLLM — must pass through **unchanged** so they stay retryable by pi's normal policy. Only the **auth/token class** is normalized.

### Console ergonomics — `gcloud-token.ts` / `auth-state.ts`

- Raw detail (including the OAuth JSON) `console.warn`s **once**, on the `broken` transition, then is suppressed while `broken`.
- One `console.warn` on recovery.
- This kills the 3× identical warn per episode observed in the field.

### UI bridge — `index.ts`

Subscribe once at extension load:

- `pi.events.on("litellm:auth_failed", async (_e, ctx) => …)` and `pi.events.on("litellm:auth_recovered", async (_e, ctx) => …)` — each handler receives a **fresh live `ctx`** (this is why the EventBus wiring was chosen over a module-var holding the latest `ctx`; pi docs warn session-bound objects go stale after session replacement / `withSession`).
- **On failure** (only on transition into `broken`): if `ctx.hasUI` —
  - `ctx.ui.notify("litellm: token invalid — run: gcloud auth application-default login", "error")`
  - `ctx.ui.setStatus("litellm", themed ⚠ warning)` (persistent footer until recovery)
  - if `!ctx.hasUI` — do nothing (the chat line covers print/RPC modes)
- **On recovery**: if `ctx.hasUI` — `ctx.ui.setStatus("litellm", undefined)` (clear) + `ctx.ui.notify("litellm: token recovered", "info")`
- Status-bar text colored via `ctx.ui.theme` (pattern: `examples/extensions/status-line.ts`).
- The handler is synchronous — not affected by the post-`await fetch()` footer re-render quirk (old-repo issue #3602).

### Scope limits

- **Static-key mode** (no `LITELLM_GCLOUD_TOKEN_AUTH`): the wrapper is only wired when `isGcloudAuth` (mirroring how `streamSimple` is only created in that mode) → zero behavior change, no events, no UI.
- **No polling/timer**: recovery is detected on the next real `getToken()` success — consistent with the package's no-timer design (existing 50-min TTL comment, `index.ts:32`).

## Tests

Unit (vitest, following `test/` patterns):

1. `unknown → broken` on exchange failure → exactly **one** `auth_failed`; repeated failures while `broken` → **zero** events.
2. `broken → valid` on first success after break → exactly one `auth_recovered`; subsequent successes → zero.
3. Classification: `invalid_grant` + `invalid_rapt` → `invalid_grant`; other non-ok → `exchange_failed`; ADC missing → `bad_credentials`.
4. Wrapper works with injected fake token fn + fake emitter (no pi, no fs, no network).
5. All token-failure paths in `stream-simple.ts` gcloud mode produce the registered one-line message.
6. That one-line message contains **no** token from pi's retryable pattern set (guards the wording-control-knob against drift).
7. Non-auth (transient proxy) error text passes through unchanged (the 502 carve-out).

## Acceptance (manual)

- Break the refresh token (let it go `invalid_rapt`, or rename the ADC to test `bad_credentials`). Send 3 prompts → expect: **1** error toast, **1** persistent footer warning, one short chat line per prompt, **1** console warn (not 3).
- Run `gcloud auth application-default login` → next prompt → footer clears, recovery toast appears, no further warns.
- `pi -p` (print mode): no toast/status crash; chat line is short.

## open-questions

- (none — surfaced wording choices are one-line changes; recovery toast vs silent clear is an open tweak noted in §Decisions/UI bridge)
