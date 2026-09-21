---
status: live
last-verified: 2026-09-21
verified-by: PR #8 merged (squash a0d4921) after Greptile re-review PASS; 106/106 vitest + tsc clean. Live check: broken-token pi session shows error notify + footer/widget + 1 short chat line per prompt; recovery clears both
---

# Surface invalid_grant failures via notify + status bar instead of chat spam

## What is live

When the GCloud OAuth refresh token is invalid (`invalid_grant`/`invalid_rapt`) or credentials are bad, pi-provider-litellm surfaces the failure **once per break** instead of per prompt:

- one `notify(…, "error")` toast, a persistent `setStatus("litellm", …)` footer warning, **and** a `setWidget(…, { placement: "aboveEditor" })` pinned above the editor (Widgets are not replaced by footer-suites like pi-archimedes, which replaced pi's built-in footer and only came to render `FooterDataProvider.getExtensionStatuses()` in archimedes PR #57)
- the footer widget is cleared + an info toast fires on recovery
- the provider stays selectable while broken (ADR 0002) — every failed prompt shows **one short line** (`AUTH_CHAT_ERROR_LINE`), never the raw OAuth JSON
- one `console.warn` with raw detail per break (suppressed while broken)

## Architecture invariants

- **`auth-state.ts`** owns the state machine (`unknown → valid | broken, broken → valid → …`): `emitFailed`/`emitRecovered` fire **once per state entry** (never per failed call); `markBroken()` exists for the "fresh token rejected by provider (401 after refresh)" case, which token-fetch success alone would not detect
- **`index.ts`**: the event bridge is registered **before** startup token consumers (`syncRemoteSkills` runs at load, before `session_start`); `session_start` **re-fires** the UI when `state() === "broken"` (a pre-start break is the common case — token was already broken when pi launched); `session_shutdown` clears the stored ctx identity-guarded
- Bus handlers use the **stored-ctx pattern** (pi's `examples/extensions/event-bus.ts`): `EventBus.on` handlers receive only `data`, never `ctx`
- The provider stays registered; recovery is detected on the next successful token fetch (no timers) — gcloud mode only, zero change in static-key mode

## Durable facts about pi (verified 0.84.2)

- Provider stream errors **always** render as red error lines in the chat — no suppression/dedupe API exists
- Turn auto-retry (default 3×, 2s exponential) is **pure string matching** of `errorMessage` against pi-ai's transient patterns (`dist/utils/retry.js`) → error wording is a **control knob**; `AUTH_CHAT_ERROR_LINE` is pinned to match none of them by a `RETRYABLE_PATTERNS` guard test
- `notify(…, "error")` in the TUI renders via `showError()` (a red line in the chat area, not a floating toast)
- Custom footers replace the built-in one — extension `setStatus` text only appears if the suite renders `FooterDataProvider.getExtensionStatuses()`

## Related

- Spec/plan history: this file's prior revisions (commits `1cce676 → a188739 → 4ec94e9`) plus the implemented plan; code in `src/auth-state.ts`, `src/gcloud-token.ts`, `src/stream-simple.ts`, `src/index.ts`
- ADR: `docs/adr/0002-keep-broken-provider-selectable.md` · Terms: `CONTEXT.md`
- Complementary: pi-archimedes PR #57 (footer now renders `setStatus` texts)
