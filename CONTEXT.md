# pi-provider-litellm

Pi coding-agent extension that auto-discovers a LiteLLM proxy and registers its models, with GCloud OAuth token auth.

## Language

**Auth state**:
The module-scoped token-health state (`unknown` | `valid` | `broken`), owned by `auth-state.ts` and reset per pi process. A fresh pi session starts at `unknown` and re-enters the cycle if the token is still broken.
_Avoid_: token state, auth status

**Broken refresh token**:
An auth state where the Google OAuth exchange fails (`invalid_grant`/`invalid_rapt` or any non-ok exchange), i.e. reauth via `gcloud auth application-default login` is required.
_Avoid_: invalid token, 401 error

**Forced refresh**:
The 401 path in `stream-simple.ts`: `resetTokenCache()` + re-exchange + one request retry.
_Avoid_: token retry, re-login

**Chat line**:
The red `Error:` block pi renders in the transcript for a failed provider stream — always rendered, unsuppressible, no dedupe.
_Avoid_: error message, error block

**Non-retryable chat line**:
Chat-line wording deliberately chosen to match none of pi's transient-error string patterns (`pi-ai/dist/utils/retry.js`), so `isRetryableAssistantError()` is false and pi's turn auto-retry (default 3 attempts) does not amplify the failure. The wording is a control knob — changing the text can silently (re)enable auto-retry.
_Avoid_: safe message, final message

**Error surface**:
Where a failure is surfaced to the user — chat line (always, per attempt), toast (`ctx.ui.notify`, not in transcript), footer (`ctx.ui.setStatus`, persistent and keyed).
_Avoid_: error display, error UI
