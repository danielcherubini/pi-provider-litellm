import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createAuthStateTracker,
  AUTH_CHAT_ERROR_LINE,
  type AuthStateDeps,
} from '../src/auth-state.js'
import type { TokenFailure } from '../src/gcloud-token.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides: Partial<AuthStateDeps> = {}): AuthStateDeps & {
  emitFailed: ReturnType<typeof vi.fn>
  emitRecovered: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
} {
  const emitFailed = vi.fn()
  const emitRecovered = vi.fn()
  const warn = vi.fn()
  return {
    getToken: async () => null,
    getFailure: () => null,
    emitFailed,
    emitRecovered,
    warn,
    ...overrides,
  }
}

const SAMPLE_FAILURE: TokenFailure = { code: 'invalid_grant', detail: 'HTTP 400: invalid_grant' }

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createAuthStateTracker', () => {
  // 1. fails once into broken
  it('fails once into broken', async () => {
    const deps = makeDeps({
      getToken: async () => null,
      getFailure: () => SAMPLE_FAILURE,
    })
    const tracker = createAuthStateTracker(deps)

    const result = await tracker.get()

    expect(result).toBe('')
    expect(tracker.state()).toBe('broken')
    expect(deps.emitFailed).toHaveBeenCalledTimes(1)
    expect(deps.emitFailed).toHaveBeenCalledWith(SAMPLE_FAILURE)
    expect(deps.warn).toHaveBeenCalledTimes(1)
  })

  // 2. suppresses while broken
  it('suppresses while broken', async () => {
    const deps = makeDeps({
      getToken: async () => null,
      getFailure: () => SAMPLE_FAILURE,
    })
    const tracker = createAuthStateTracker(deps)

    await tracker.get() // first failure → broken
    await tracker.get() // second failure → suppressed

    expect(tracker.state()).toBe('broken')
    expect(deps.emitFailed).toHaveBeenCalledTimes(1)
    expect(deps.warn).toHaveBeenCalledTimes(1)
  })

  // 3. recovery emits exactly once
  it('recovery emits exactly once', async () => {
    let shouldFail = true
    const deps = makeDeps({
      getToken: async () => (shouldFail ? null : 'tok'),
      getFailure: () => SAMPLE_FAILURE,
    })
    const tracker = createAuthStateTracker(deps)

    await tracker.get() // → broken
    await tracker.get() // still broken, suppressed

    shouldFail = false
    const result1 = await tracker.get() // recovery
    expect(result1).toBe('tok')
    expect(tracker.state()).toBe('valid')
    expect(deps.emitRecovered).toHaveBeenCalledTimes(1)
    // recovery warn: exactly 1 additional warn (total: 1 break + 1 recovery = 2)
    expect(deps.warn).toHaveBeenCalledTimes(2)

    const result2 = await tracker.get() // second success — no new events
    expect(result2).toBe('tok')
    expect(deps.emitRecovered).toHaveBeenCalledTimes(1)
    expect(deps.warn).toHaveBeenCalledTimes(2)
  })

  // 4. re-arms after recovery
  it('re-arms after recovery', async () => {
    let shouldFail = true
    const deps = makeDeps({
      getToken: async () => (shouldFail ? null : 'tok'),
      getFailure: () => SAMPLE_FAILURE,
    })
    const tracker = createAuthStateTracker(deps)

    await tracker.get() // broken (emitFailed: 1)
    shouldFail = false
    await tracker.get() // valid (emitRecovered: 1)
    shouldFail = true
    await tracker.get() // broken again (emitFailed: 2)

    expect(deps.emitFailed).toHaveBeenCalledTimes(2)
    expect(deps.warn).toHaveBeenCalledTimes(3) // break + recovery + break
    expect(tracker.state()).toBe('broken')
  })

  // 5. first success from unknown is silent
  it('first success from unknown is silent', async () => {
    const deps = makeDeps({
      getToken: async () => 'tok',
      getFailure: () => null,
    })
    const tracker = createAuthStateTracker(deps)

    const result = await tracker.get()

    expect(result).toBe('tok')
    expect(tracker.state()).toBe('valid')
    expect(deps.emitFailed).not.toHaveBeenCalled()
    expect(deps.emitRecovered).not.toHaveBeenCalled()
    expect(deps.warn).not.toHaveBeenCalled()
  })

  // 6. empty failure falls back to exchange_failed
  it('empty failure falls back to exchange_failed', async () => {
    const deps = makeDeps({
      getToken: async () => null,
      getFailure: () => null,
    })
    const tracker = createAuthStateTracker(deps)

    await tracker.get()

    expect(deps.emitFailed).toHaveBeenCalledWith({
      code: 'exchange_failed',
      detail: 'token fetch returned empty',
    })
  })

  // 7. reset
  it('reset goes to unknown, fires no events, re-arms on next failure', async () => {
    const deps = makeDeps({
      getToken: async () => null,
      getFailure: () => SAMPLE_FAILURE,
    })
    const tracker = createAuthStateTracker(deps)

    await tracker.get() // broken (emitFailed: 1, warn: 1)

    tracker.reset()
    expect(tracker.state()).toBe('unknown')
    // reset itself fires nothing extra
    expect(deps.emitFailed).toHaveBeenCalledTimes(1)
    expect(deps.emitRecovered).not.toHaveBeenCalled()
    expect(deps.warn).toHaveBeenCalledTimes(1)

    await tracker.get() // broken again (emitFailed: 2, warn: 2)
    expect(deps.emitFailed).toHaveBeenCalledTimes(2)
    expect(deps.warn).toHaveBeenCalledTimes(2)
  })

  // 8. get() returns '' (never undefined) on failure
  it("get() returns '' on failure, never undefined", async () => {
    const deps = makeDeps({
      getToken: async () => null,
      getFailure: () => null,
    })
    const tracker = createAuthStateTracker(deps)

    const result = await tracker.get()
    expect(result).toBe('')
    expect(result).not.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// AUTH_CHAT_ERROR_LINE constant
// ---------------------------------------------------------------------------

describe('AUTH_CHAT_ERROR_LINE', () => {
  it('is exported with the exact wording including em dash', () => {
    expect(AUTH_CHAT_ERROR_LINE).toBe(
      'litellm: Google token invalid \u2014 re-auth required: gcloud auth application-default login',
    )
  })
})
