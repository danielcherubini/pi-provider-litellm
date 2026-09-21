---
status: committed
done-when: An invalid_grant failure produces at most one short chat line per prompt (non-retryable wording), exactly one error toast + one persistent footer warning per break, ≤1 console warn per break/recovery, and recovery (next successful token exchange) clears the footer and fires an info toast — verified by the unit tests in Tasks 1-4 and the manual acceptance scenario in Task 5.
---

# Litellm auth error surface — Implementation Plan

**Goal:** Replace `invalid_grant` chat spam with (1) one error toast per break, (2) a persistent footer warning until recovery, (3) one short non-retryable chat line per failed prompt, (4) ≤1 console warn per break/recovery.

**Architecture:** A new `auth-state.ts` state machine (`unknown → broken | valid, broken → valid → …`) wraps `getGcloudToken()` and classifies failures via a new failure sink in `gcloud-token.ts`; state transitions emit on `pi.events`. `stream-simple.ts` normalizes all gcloud token-failure messages to one constant line. `index.ts` (gcloud mode only) bridges the bus to `ctx.ui.notify`/`setStatus` using the shipped `examples/extensions/event-bus.ts` stored-ctx pattern.

**Tech stack:** TypeScript (ESM; relative imports use `.js` extensions), vitest, `@earendil-works/pi-coding-agent` (type imports in `src/` only — never a runtime import of pi in `src/`).

**Global notes for the executing agent:**
- Test command per file: `npx vitest run test/<file>.test.ts`; full suite: `npm run test:run` (non-watch); type check: `npm run typecheck`.
- Follow existing test style: explicit `import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'`, imports of `../src/<file>.js`.
- The spec this plan implements (context, decisions, rejected options, wording rationale) is the **previous revision of this file** — `git show HEAD~1:docs/roadmap/litellm-auth-error-surface.md`. Read it before Task 2.
- Never `console.warn` on per-failure paths in `gcloud-token.ts` after Task 1 — warn ownership moves to `auth-state.ts`.

---

### Task 1: `gcloud-token.ts` failure sink

**Context:** Today every failed token exchange `console.warn`s, per attempt — the observed 3× log spam. The Task 2 state machine needs to know *why* the exchange failed (a `code` + raw `detail` for the console log only). This task moves warn ownership out of `gcloud-token.ts` and replaces it with a queryable "last failure" sink. The public `getGcloudToken(): Promise<string | null>` signature and the 50-min TTL coalescing behavior are unchanged.

**Files:**
- Modify: `src/gcloud-token.ts`
- Modify: `test/gcloud-token.test.ts`

**What to implement:**

In `src/gcloud-token.ts`, add:

```ts
export type TokenFailureCode = 'invalid_grant' | 'exchange_failed' | 'bad_credentials'
export interface TokenFailure { code: TokenFailureCode; detail: string }

let lastTokenFailure: TokenFailure | null = null
export function getLastTokenFailure(): TokenFailure | null {
  return lastTokenFailure
}
```

Record the sink (replacing each current `console.warn` failure call with a sink record — **remove the warn calls**):

| Failure path in `getGcloudToken()` / `exchangeRefreshToken()` | `code` | `detail` |
|---|---|---|
| `!response.ok` in `exchangeRefreshToken` | `text.includes('invalid_grant') ? 'invalid_grant' : 'exchange_failed'` | `` `HTTP ${response.status}: ${text}` `` |
| `catch` (network/abort) in `exchangeRefreshToken` | `'exchange_failed'` | `` `Network error: ${error}` `` |
| no ADC path found | `'bad_credentials'` | `'No Google ADC file found (set GOOGLE_APPLICATION_CREDENTIALS or run gcloud auth application-default login)'` |
| unreadable/unparseable ADC file | `'bad_credentials'` | `` `Failed to read ADC file: ${adcPath}` `` |
| `service_account` credentials | `'bad_credentials'` | `'Service account credentials are not yet supported (need authorized_user)'` |
| unknown credentials type | `'bad_credentials'` | `` `Unknown credential type` `` |

Also:
- On a **successful** exchange (the branch that sets `cachedToken`), reset `lastTokenFailure = null`.
- `resetTokenCache()` must also reset `lastTokenFailure = null` (the 401 forced-refresh path in `stream-simple.ts` calls it).

**Do not change:** `CACHE_TTL`, request coalescing (`inflight`), `getAdcPath()`/`readCredentials()` logic, `getGcloudToken` return type.

**Steps:**
- [ ] Edit `test/gcloud-token.test.ts`: keep the existing `warnSpy` pattern but now assert `expect(warnSpy).not.toHaveBeenCalled()` in the 5 failure-path tests, AND assert the sink:
  - no-ADC test → `expect(getLastTokenFailure()).toMatchObject({ code: 'bad_credentials' })`
  - invalid-JSON test → `code: 'bad_credentials'`
  - service-account test → `code: 'bad_credentials'` (and drop the old exact-warn assertion on lines ~118-130)
  - exchange-failure test (400 + `{"error":"invalid_grant"}`) → `code: 'invalid_grant'`
  - network-error test → `code: 'exchange_failed'`
  - Add test: after a successful exchange, `getLastTokenFailure()` returns `null` (call it after the existing success test setup).
  - Add test: after a failure, `resetTokenCache()` clears the sink (`getLastTokenFailure()` → `null`).
- [ ] Run `npx vitest run test/gcloud-token.test.ts`
  - Did it fail with the new sink assertions (undefined function / code mismatch)? If it passed unexpectedly, stop and investigate.
- [ ] Implement the sink + warn removal in `src/gcloud-token.ts`.
- [ ] Run `npx vitest run test/gcloud-token.test.ts`
  - Did all tests pass? If not, fix and re-run.
- [ ] Run `npm run typecheck`
- [ ] Commit: `feat: record token-failure sink in gcloud-token, remove per-failure console.warn`

**Acceptance criteria:**
- [ ] No `console.warn` call remains on any failure path in `src/gcloud-token.ts`.
- [ ] `getLastTokenFailure()` returns the classified code/detail after each failure class and `null` after success and after `resetTokenCache()`.

---

### Task 2: `src/auth-state.ts` state machine

**Context:** The dedupe heart of the feature. It wraps the token fetch, tracks `unknown | valid | broken`, and guarantees `emitFailed`/`emitRecovered` fire **once per state entry** — repeated failures while `broken` (each user prompt) emit nothing and warn nothing. It also owns the console warn (raw `detail` appears in the log exactly once per break), and exposes the single chat-line constant used by Task 3. Read the spec (previous revision of this file) for the wording rationale before writing `AUTH_CHAT_ERROR_LINE`.

**Files:**
- Create: `src/auth-state.ts`
- Create: `test/auth-state.test.ts`

**What to implement — exact API:**

```ts
import type { TokenFailure } from './gcloud-token.js'

export type AuthState = 'unknown' | 'valid' | 'broken'

export interface AuthStateDeps {
  getToken: () => Promise<string | null>
  getFailure: () => TokenFailure | null
  emitFailed: (e: TokenFailure) => void
  emitRecovered: () => void
  warn: (msg: string) => void
}

export interface AuthStateTracker {
  get: () => Promise<string>   // returns '' on failure — mirrors the `?? ''` contract in index.ts
  state: () => AuthState
  reset: () => void           // back to 'unknown', emits nothing (tests / process restart)
}

export function createAuthStateTracker(deps: AuthStateDeps): AuthStateTracker

// Single source of truth for the normalized gcloud token-failure chat line.
// WORDING IS A CONTROL KNOB: it must match none of pi's transient-error
// patterns (node_modules/@earendil-works/pi-ai/dist/utils/retry.js
// RETRYABLE_PROVIDER_ERROR_PATTERN) or pi's turn auto-retry will amplify
// every failed prompt. Guarded by the test in Task 3.
export const AUTH_CHAT_ERROR_LINE =
  'litellm: Google token invalid — re-auth required: gcloud auth application-default login'
```

`get()` logic, exactly:

```
token = await deps.getToken()
if (token !== '' ) {                       // successful, non-empty
  if (state === 'broken') { state = 'valid'; deps.emitRecovered(); deps.warn('litellm: gcloud token recovered') }
  else if (state === 'unknown') { state = 'valid' }   // no event for the first success
  return token
}
// token === '' → failure
const failure = deps.getFailure()
const e: TokenFailure = failure ?? { code: 'exchange_failed', detail: 'token fetch returned empty' }
if (state !== 'broken') {
  state = 'broken'
  deps.emitFailed(e)
  deps.warn(`[pi-provider-litellm] token failed (${e.code}): ${e.detail}`)
}
// state === 'broken': SUPPRESS — no emit, no warn
return ''
```

No module-level singletons — all state lives inside the closure returned by `createAuthStateTracker`.

**Steps:**
- [ ] Write `test/auth-state.test.ts` with fully injected fakes (no fs, no network, no pi). Helper: `function makeDeps(overrides)` returning `{ getToken, getFailure, emitFailed: vi.fn(), emitRecovered: vi.fn(), warn: vi.fn() }` plus `newTracker = () => createAuthStateTracker(makeDeps())`. Tests:
  1. `fails once into broken` — `getToken → null`, `getFailure → {code:'invalid_grant', detail:'HTTP 400: …'}`: first `get()` → `''`, `emitFailed` called exactly once with the failure object; `state()` → `'broken'`.
  2. `suppresses while broken` — second `get()` (still failing) → `''`, `emitFailed` still 1 total, `warn` still 1 total.
  3. `recovery emits exactly once` — after (1)-(2), `getToken → 'tok'`: `get()` → `'tok'`, `state()` → `'valid'`, `emitRecovered` 1, recovery warn fired. Then another success → no second `emitRecovered`.
  4. `re-arms after recovery` — success after recovery → fail again → `emitFailed` fires **again** (2 total for the session) and warn fires again: proves `broken → valid → broken` re-enters.
  5. `first success from unknown is silent` — `getToken → 'tok'` as the very first call → no `emitFailed`/`emitRecovered`, `state()` → `'valid'`.
  6. `empty failure falls back to exchange_failed` — `getToken → ''`, `getFailure → null` → `emitFailed` called with `{ code: 'exchange_failed', detail: 'token fetch returned empty' }`.
  7. `reset` — after (1), `reset()` → `state()` → `'unknown'`, no events fired by `reset()`, next failure re-emits.
  8. `returns falsy token as '' contract` — `getToken → ''` is treated as failure (covered by 1/6; assert `get()` returns `''` not `undefined`).
- [ ] Run `npx vitest run test/auth-state.test.ts`
  - Did it fail with an import error / missing module? (Expected — the file doesn't exist yet.)
- [ ] Implement `src/auth-state.ts` exactly per the API above.
- [ ] Run `npx vitest run test/auth-state.test.ts`
  - Did all tests pass? If not, fix and re-run.
- [ ] Run `npm run typecheck`
- [ ] Commit: `feat: add auth-state machine with once-per-transition events`

**Acceptance criteria:**
- [ ] `emitFailed`/`emitRecovered` fire exactly once per state entry; zero events for repeated failures while `broken`.
- [ ] `warn` fires at most once per break and once per recovery.
- [ ] `AUTH_CHAT_ERROR_LINE` is exported from `src/auth-state.ts` with the exact string from the spec.

---

### Task 3: `stream-simple.ts` — one chat line for all gcloud token failures

**Context:** In gcloud mode every token failure (exchange fails before the request; 401 → forced refresh fails; 401 again after refresh) must produce the single constant `AUTH_CHAT_ERROR_LINE` instead of three different verbose messages. The 401 detection logic, the 401-path `console.warn`s, `resetTokenCache()`, and the non-auth (transient proxy) error pass-through are **unchanged** — a real 502 from LiteLLM must keep its current text so pi auto-retries it.

**Files:**
- Modify: `src/stream-simple.ts`
- Modify: `test/stream-simple.test.ts`

**What to implement:**

In `src/stream-simple.ts`:
- Add `import { AUTH_CHAT_ERROR_LINE } from './auth-state.js'`.
- Replace the error string `'Failed to refresh gcloud token after 401'` → `AUTH_CHAT_ERROR_LINE`.
- Replace the error string `'Authentication failed after token refresh (401 Unauthorized)'` → `AUTH_CHAT_ERROR_LINE`.
- Leave the `catch (err)` block (generic unexpected errors) untouched.

**Do not change:** the `is401` detection, the 401/refresh `console.warn` lines, `makeError` helper, header/session-id logic.

**Steps:**
- [ ] Edit `test/stream-simple.test.ts`:
  1. Find the existing tests that assert the two old messages (`'Failed to refresh gcloud token after 401'`, `'Authentication failed after token refresh (401 Unauthorized)'`) and change the expectations to `AUTH_CHAT_ERROR_LINE` (import it from `../src/auth-state.js`).
  2. Add the **wording guard test** `it('AUTH_CHAT_ERROR_LINE matches no pi transient-error pattern')`: copy the pattern list from `node_modules/@earendil-works/pi-ai/dist/utils/retry.js` (`RETRYABLE_PROVIDER_ERROR_PATTERN`) into a local `const RETRYABLE_PATTERNS: string[]` in the test file with a comment `// KEEP IN SYNC with pi-ai dist/utils/retry.js (checked 2026-09-21)`. For each pattern: `expect(new RegExp(p, 'i').test(AUTH_CHAT_ERROR_LINE)).toBe(false)`.
  3. Confirm the existing non-auth pass-through tests still pass (do not modify them).
- [ ] Run `npx vitest run test/stream-simple.test.ts`
  - Did the updated message assertions fail (old strings still emitted)? If the guard test passes trivially before implementation, that's fine — it guards `auth-state.ts` from Task 2.
- [ ] Implement the two replacements in `src/stream-simple.ts`.
- [ ] Run `npx vitest run test/stream-simple.test.ts`
  - Did all tests pass? If not, fix and re-run.
- [ ] Run `npm run typecheck`
- [ ] Commit: `feat: collapse gcloud token failures to one non-retryable chat line`

**Acceptance criteria:**
- [ ] All three gcloud token-failure paths in `stream-simple.ts` emit exactly `AUTH_CHAT_ERROR_LINE`.
- [ ] The guard test fails if `AUTH_CHAT_ERROR_LINE` gains any transient-pattern token (e.g. `timeout`).

---

### Task 4: `index.ts` — wire the bus to notify + status bar

**Context:** The UI bridge. Verified against `dist/core/event-bus.d.ts`: `EventBus.on(channel, handler)` handlers receive **only `data`** — never a `ctx`. The canonical pattern for UI usage from a bus handler is shipped in `examples/extensions/event-bus.ts`: a module-scoped `currentCtx` refreshed in `session_start` (we also refresh it in the `litellm-skills` command handler for cheap robustness). Staleness after a `withSession` replacement is an accepted risk (events only fire on token fetch attempts, which require a live session; the chat line + console warn fire regardless of `ctx`).

**Files:**
- Modify: `src/index.ts`
- Modify: `test/index.test.ts`

**What to implement:**

In `src/index.ts`:

1. Imports — do NOT add a second import from `@earendil-works/pi-coding-agent`: merge `ExtensionContext` into the existing line 1 `import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'` (→ `import type { ExtensionAPI, ExtensionContext } ...`), extend the existing `import { getGcloudToken } from './gcloud-token.js'` with `getLastTokenFailure`, and add `import { createAuthStateTracker } from './auth-state.js'`:
```ts
// line 1 becomes:
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { createAuthStateTracker } from './auth-state.js'
import { getGcloudToken, getLastTokenFailure } from './gcloud-token.js'
```

2. In the factory, right after `const isGcloudAuth = …`:
```ts
let currentCtx: ExtensionContext | undefined

const authTracker = isGcloudAuth
  ? createAuthStateTracker({
      getToken: () => getGcloudToken(),
      getFailure: () => getLastTokenFailure(),
      emitFailed: (e) => pi.events.emit('litellm:auth_failed', e),
      emitRecovered: () => pi.events.emit('litellm:auth_recovered', undefined),
      warn: (msg) => console.warn(msg),
    })
  : undefined
```

3. Replace the existing `getToken` gcloud branch so **every** gcloud token fetch (auth resolve, skills sync, stream) goes through the tracker:
```ts
const getToken = async (): Promise<string> => {
  if (isGcloudAuth) {
    if (authTracker) return authTracker.get()
    return (await getGcloudToken()) ?? ''
  }
  return config.apiKey
}
```

4. In the `session_start` handler, add `currentCtx = ctx` as the first statement. In the `litellm-skills` command handler, add `currentCtx = ctx` as its first statement.

5. After the provider registration block (still inside the factory, gcloud mode only — gate on `authTracker`), register the bus handlers:
```ts
if (authTracker) {
  pi.events.on('litellm:auth_failed', (data) => {
    const ctx = currentCtx
    if (!ctx?.hasUI) return
    ctx.ui.notify('litellm: token invalid — run: gcloud auth application-default login', 'error')
    ctx.ui.setStatus('litellm', ctx.ui.theme.fg('error', '⚠ litellm token invalid — re-auth required'))
  })
  pi.events.on('litellm:auth_recovered', () => {
    const ctx = currentCtx
    if (!ctx?.hasUI) return
    ctx.ui.setStatus('litellm', undefined)
    ctx.ui.notify('litellm: token recovered', 'info')
  })
}
```

**Do not change:** static-mode behavior, MCP discovery, skills-toggle command body, session-id logic, `buildNativeProvider` wiring.

**Steps:**
- [ ] Edit `test/index.test.ts` (follow the existing `createMockPi` + `vi.doMock` + factory-call pattern in this file):
  1. Extend `MockPi` with `events: { on: ..., emit: ... }` where `on: vi.fn((channel: string, handler: Function) => { (handlers['events'] ??= []).push({ channel, handler }) })` (add an `eventsEntries` helper to look up handlers by channel) and `emit: vi.fn()`.
  2. Add `vi.doMock('../src/gcloud-token.js', () => ({ getGcloudToken: vi.fn(() => Promise.resolve('tok')), resetTokenCache: vi.fn(), getLastTokenFailure: vi.fn(() => null) }))` (and make sure any existing gcloud-token mock in this file is replaced consistently).
  3. Add a `makeFakeCtx()` helper: `{ hasUI: true, ui: { notify: vi.fn(), setStatus: vi.fn(), theme: { fg: (_c: string, t: string) => t } } }`.
  4. Tests (all gcloud mode: `vi.stubEnv('LITELLM_GCLOUD_TOKEN_AUTH', '1')` before importing the factory, `vi.resetModules()` per test as the file already does):
     a. `bridge: auth_failed fires notify + status once` — run the factory, invoke the stored `session_start` handler with `makeFakeCtx()`, then invoke the `events` handler for channel `litellm:auth_failed` with `{ code: 'invalid_grant', detail: 'HTTP 400: …' }` → `notify` called exactly once with `('litellm: token invalid — run: gcloud auth application-default login', 'error')`; `setStatus` called exactly once with `('litellm', '⚠ litellm token invalid — re-auth required')`.
     b. `bridge: auth_recovered clears status + info toast` — same setup; invoke `litellm:auth_recovered` handler → `setStatus('litellm', undefined)` and `notify('litellm: token recovered', 'info')` each exactly once.
     c. `bridge: no UI ops without ctx/hasUI` — (i) invoke the failed handler **before** any `session_start` → no notify/setStatus calls; (ii) with a ctx of `hasUI: false` → no notify/setStatus calls.
     d. `static mode registers no litellm bus handlers` — env unset; after factory run, `events.on` was never called with `litellm:auth_failed` / `litellm:auth_recovered`.
  5. Ensure all pre-existing tests in the file still pass (they should — the mock pi extension is additive).
- [ ] Run `npx vitest run test/index.test.ts`
  - Did the 4 new tests fail (handlers not yet wired)?
- [ ] Implement `src/index.ts` per the 5 numbered changes above.
- [ ] Run `npx vitest run test/index.test.ts`
  - Did all tests pass? If not, fix and re-run.
- [ ] Run the full suite `npm run test:run` and `npm run typecheck`.
- [ ] Commit: `feat: bridge auth-state events to notify + footer status (stored-ctx pattern)`

**Acceptance criteria:**
- [ ] In gcloud mode, a `litellm:auth_failed` event produces exactly one `notify('…','error')` + one `setStatus('litellm', …)` when a UI ctx exists; a `litellm:auth_recovered` event clears the status and fires one info toast.
- [ ] In static-key mode no litellm bus handlers are registered and no behavior changed.

---

### Task 5: Full verification + manual acceptance

**Context:** Nothing to implement — this task exists so the feature is only "done" when the observable acceptance criteria hold, not just when unit tests pass.

**Steps:**
- [ ] Run `npm run test:run` (full vitest suite, non-watch) — did **all** tests pass? If not, debug and re-run before anything else.
- [ ] Run `npm run typecheck` — did it succeed?
- [ ] `grep -rn "console.warn" src/gcloud-token.ts` — confirm **zero** matches on failure paths (only non-failure paths, if any, may warn).
- [ ] Manual acceptance (needs a machine with a broken gcloud refresh token; if unavailable, script the sequence the user runs and record their output):
  1. Break the token (let it go `invalid_rapt`, or temporarily rename the ADC file for the `bad_credentials` path). Send 3 prompts → **observe:** exactly 1 error toast, 1 persistent footer warning, one short chat line per prompt, 1 console warn (not 3).
  2. Run `gcloud auth application-default login` → send 1 prompt → **observe:** footer cleared, recovery toast, no further warns, the prompt works.
  3. `pi -p` (print mode) with a broken token → **observe:** no crash, short chat line.
- [ ] If any manual step deviates from expectations, fix the defect in the relevant task's files, re-run `npm run test:run` + `npm run typecheck`, and re-verify.
- [ ] No code changes expected; if a fix landed, commit it: `fix: litellm auth error surface acceptance fix`

**Acceptance criteria:**
- [ ] Full suite green, typecheck green, no per-failure warns in `gcloud-token.ts`.
- [ ] All three manual acceptance observations hold.
