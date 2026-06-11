import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// --- helpers ----------------------------------------------------------------

/** Minimal EventStream that supports push/end and async iteration. */
function createFakeStream() {
  const queue: Array<{ value: unknown; done: boolean }> = []
  let waiting: Array<(v: { value: unknown; done: boolean }) => void> = []
  let ended = false

  return {
    push(event: Record<string, unknown>) {
      if (ended) return
      const waiter = waiting.shift()
      if (waiter) {
        waiter({ value: event, done: false })
      } else {
        queue.push({ value: event, done: false })
      }
    },
    end() {
      ended = true
      while (waiting.length) {
        waiting.shift()!({ value: undefined, done: true })
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<{ value: unknown; done: boolean }> {
          if (queue.length) return Promise.resolve(queue.shift()!)
          if (ended) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve) => waiting.push(resolve))
        },
      }
    },
    result() {
      return Promise.resolve(undefined)
    },
  }
}

// --- mocks ------------------------------------------------------------------

const mockStreamSimpleOpenAICompletions = vi.hoisted(() => vi.fn())
const mockResetTokenCache = vi.hoisted(() => vi.fn())

vi.mock('@earendil-works/pi-ai', () => ({
  createAssistantMessageEventStream: () => createFakeStream(),
  streamSimpleOpenAICompletions: mockStreamSimpleOpenAICompletions,
}))

vi.mock('../src/gcloud-token.js', () => ({
  resetTokenCache: mockResetTokenCache,
}))

import { createGcloudStreamSimple } from '../src/stream-simple.js'

// --- helpers for consuming the outer stream ---------------------------------

async function collectEvents(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = []
  for await (const event of stream) {
    events.push(event)
  }
  return events
}

// --- tests ------------------------------------------------------------------

describe('createGcloudStreamSimple', () => {
  const fakeModel = { api: 'openai-completions', provider: 'test', id: 'test-model' } as any
  const fakeContext = { systemPrompt: '', messages: [], tools: [] } as any

  let getToken: ReturnType<typeof vi.fn>
  let reregister: ReturnType<typeof vi.fn>

  beforeEach(() => {
    getToken = vi.fn().mockResolvedValue('token-1')
    reregister = vi.fn()
    mockStreamSimpleOpenAICompletions.mockReset()
    mockResetTokenCache.mockReset()
  })

  it('forwards events from the inner stream to the outer stream', async () => {
    const inner = createFakeStream()
    mockStreamSimpleOpenAICompletions.mockReturnValue(inner)

    const streamSimple = createGcloudStreamSimple(getToken, reregister)
    const outer = streamSimple(fakeModel, fakeContext)

    // Push events through the inner stream
    inner.push({ type: 'start', partial: {} })
    inner.push({ type: 'text_delta', delta: 'hello' })
    inner.push({ type: 'done', reason: 'stop', message: {} })
    inner.end()

    const events = await collectEvents(outer as any)
    expect(events).toHaveLength(3)
    expect((events[0] as any).type).toBe('start')
    expect((events[1] as any).type).toBe('text_delta')
    expect((events[2] as any).type).toBe('done')
  })

  it('injects the token from getToken into apiKey', async () => {
    const inner = createFakeStream()
    mockStreamSimpleOpenAICompletions.mockReturnValue(inner)

    const streamSimple = createGcloudStreamSimple(getToken, reregister)
    streamSimple(fakeModel, fakeContext)

    // Let the async IIFE run
    await new Promise((r) => setTimeout(r, 0))

    expect(mockStreamSimpleOpenAICompletions).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ apiKey: 'token-1' }),
    )

    inner.push({ type: 'done', reason: 'stop', message: {} })
    inner.end()
  })

  it('retries with a fresh token on 401 error', async () => {
    // First attempt: returns 401 error
    const inner1 = createFakeStream()
    // Second attempt: succeeds
    const inner2 = createFakeStream()

    getToken
      .mockResolvedValueOnce('token-1')
      .mockResolvedValueOnce('token-2')

    mockStreamSimpleOpenAICompletions
      .mockReturnValueOnce(inner1)
      .mockReturnValueOnce(inner2)

    const streamSimple = createGcloudStreamSimple(getToken, reregister)
    const outer = streamSimple(fakeModel, fakeContext)

    // Simulate 401 on first stream
    inner1.push({ type: 'error', reason: 'error', error: { errorMessage: '401 Unauthorized' } })
    inner1.end()

    // Wait for retry to kick in
    await new Promise((r) => setTimeout(r, 10))

    // Second stream succeeds
    inner2.push({ type: 'start', partial: {} })
    inner2.push({ type: 'done', reason: 'stop', message: {} })
    inner2.end()

    const events = await collectEvents(outer as any)
    expect(events).toHaveLength(2)
    expect((events[0] as any).type).toBe('start')
    expect((events[1] as any).type).toBe('done')

    // Verify token cache was reset and provider re-registered
    expect(mockResetTokenCache).toHaveBeenCalled()
    expect(reregister).toHaveBeenCalledWith('token-2')
    // Two calls to streamSimpleOpenAICompletions
    expect(mockStreamSimpleOpenAICompletions).toHaveBeenCalledTimes(2)
  })

  it('forwards non-auth errors without retrying', async () => {
    const inner = createFakeStream()
    mockStreamSimpleOpenAICompletions.mockReturnValue(inner)

    const streamSimple = createGcloudStreamSimple(getToken, reregister)
    const outer = streamSimple(fakeModel, fakeContext)

    inner.push({ type: 'error', reason: 'error', error: { errorMessage: 'rate limit exceeded' } })
    inner.end()

    const events = await collectEvents(outer as any)
    expect(events).toHaveLength(1)
    expect((events[0] as any).type).toBe('error')
    expect((events[0] as any).error.errorMessage).toBe('rate limit exceeded')

    // No retry
    expect(mockResetTokenCache).not.toHaveBeenCalled()
    expect(mockStreamSimpleOpenAICompletions).toHaveBeenCalledTimes(1)
  })

  it('emits error when token refresh returns empty after 401', async () => {
    const inner = createFakeStream()
    mockStreamSimpleOpenAICompletions.mockReturnValue(inner)

    getToken
      .mockResolvedValueOnce('token-1')
      .mockResolvedValueOnce('') // empty token on refresh

    const streamSimple = createGcloudStreamSimple(getToken, reregister)
    const outer = streamSimple(fakeModel, fakeContext)

    inner.push({ type: 'error', reason: 'error', error: { errorMessage: '401 Unauthorized' } })
    inner.end()

    const events = await collectEvents(outer as any)
    expect(events).toHaveLength(1)
    expect((events[0] as any).type).toBe('error')
    expect((events[0] as any).error.errorMessage).toContain('Failed to refresh gcloud token')
  })

  it('emits error when retry also gets 401', async () => {
    const inner1 = createFakeStream()
    const inner2 = createFakeStream()

    getToken
      .mockResolvedValueOnce('token-1')
      .mockResolvedValueOnce('token-2')

    mockStreamSimpleOpenAICompletions
      .mockReturnValueOnce(inner1)
      .mockReturnValueOnce(inner2)

    const streamSimple = createGcloudStreamSimple(getToken, reregister)
    const outer = streamSimple(fakeModel, fakeContext)

    // First 401
    inner1.push({ type: 'error', reason: 'error', error: { errorMessage: '401 Unauthorized' } })
    inner1.end()

    await new Promise((r) => setTimeout(r, 10))

    // Second 401
    inner2.push({ type: 'error', reason: 'error', error: { errorMessage: '401 Unauthorized' } })
    inner2.end()

    const events = await collectEvents(outer as any)
    expect(events).toHaveLength(1)
    expect((events[0] as any).type).toBe('error')
    expect((events[0] as any).error.errorMessage).toContain('Authentication failed after token refresh')
  })

  it('emits error when getToken throws', async () => {
    getToken.mockRejectedValue(new Error('credential file missing'))

    const streamSimple = createGcloudStreamSimple(getToken, reregister)
    const outer = streamSimple(fakeModel, fakeContext)

    const events = await collectEvents(outer as any)
    expect(events).toHaveLength(1)
    expect((events[0] as any).type).toBe('error')
    expect((events[0] as any).error.errorMessage).toBe('credential file missing')
  })
})
