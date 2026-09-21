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
  /** Returns '' on failure — mirrors the `?? ''` contract in index.ts */
  get: () => Promise<string>
  state: () => AuthState
  /** Back to 'unknown', emits nothing (tests / process restart) */
  reset: () => void
  /** Explicit broken entry — e.g. token rejected by provider. Suppressed if already broken. */
  markBroken(failure?: TokenFailure): void
}

// Single source of truth for the normalized gcloud token-failure chat line.
// WORDING IS A CONTROL KNOB: it must match none of pi's transient-error
// patterns (node_modules/@earendil-works/pi-ai/dist/utils/retry.js
// RETRYABLE_PROVIDER_ERROR_PATTERN) or pi's turn auto-retry will amplify
// every failed prompt.
export const AUTH_CHAT_ERROR_LINE =
  'litellm: Google token invalid \u2014 re-auth required: gcloud auth application-default login'

// Centralized wording for the toast notification and footer status shown when
// a gcloud token failure is surfaced to the UI. Kept here so a wording change
// only requires editing one file (these strings do NOT go through pi's retry
// classifier, so no knob-warning needed).
export const AUTH_TOAST_LINE = 'litellm: token invalid \u2014 run: gcloud auth application-default login'
export const AUTH_STATUS_LINE = '⚠ litellm token invalid \u2014 re-auth required'

export function createAuthStateTracker(deps: AuthStateDeps): AuthStateTracker {
  let state: AuthState = 'unknown'

  /** Shared once-per-entry logic for transitioning to 'broken'. */
  function enterBroken(e: TokenFailure): void {
    if (state !== 'broken') {
      state = 'broken'
      deps.emitFailed(e)
      deps.warn(`[pi-provider-litellm] token failed (${e.code}): ${e.detail}`)
    }
    // state === 'broken': SUPPRESS — no emit, no warn
  }

  async function get(): Promise<string> {
    const token = await deps.getToken()

    if (token !== null && token !== '') {
      // Successful, non-empty token
      if (state === 'broken') {
        state = 'valid'
        deps.emitRecovered()
        deps.warn('litellm: gcloud token recovered')
      } else if (state === 'unknown') {
        state = 'valid'
        // No event for the first success
      }
      return token
    }

    // token is null or '' → failure
    const failure = deps.getFailure()
    const e: TokenFailure = failure ?? { code: 'exchange_failed', detail: 'token fetch returned empty' }
    enterBroken(e)
    return ''
  }

  function markBroken(failure?: TokenFailure): void {
    const e: TokenFailure = failure ?? {
      code: 'exchange_failed',
      detail: 'token rejected by provider (401 after refresh)',
    }
    enterBroken(e)
  }

  function getState(): AuthState {
    return state
  }

  function reset(): void {
    state = 'unknown'
    // Emits nothing
  }

  return { get, state: getState, reset, markBroken }
}
