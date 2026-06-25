// @earendil-works/pi-ai is available at runtime inside pi's process.
// It is also installed as a devDependency (file: reference) for local type-checking.
import {
  createAssistantMessageEventStream,
  // Use the concrete streamer — the generic `streamSimple` resolves via the
  // global registry which our plugin replaces, causing infinite recursion.
  streamSimpleOpenAICompletions,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type Api,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
} from '@earendil-works/pi-ai'
import { resetTokenCache } from './gcloud-token.js'
import type { StreamSimpleFn } from './types.js'

const LOG = '[pi-provider-litellm]'

/** Stable session ID injected into every request as x-litellm-session-id. */
let currentSessionId: string | undefined

export function setSessionId(id: string | undefined): void {
  currentSessionId = id
}

export function getSessionId(): string | undefined {
  return currentSessionId
}

/**
 * Creates a streamSimple handler that:
 *
 * 1. Fetches a fresh gcloud token on every call (gcloud-token has its own 50-min cache,
 *    so this is essentially free within the window).
 * 2. Delegates to pi-ai's openai-completions streamer directly, injecting the fresh token
 *    via options.apiKey (the handler checks options.apiKey first, before the static key).
 * 3. On a 401 / auth error, force-refreshes the token, re-registers the provider, and retries once.
 *
 * For non-litellm providers (e.g., tama), delegates directly to the standard OpenAI
 * completions streamer without gcloud token logic. This avoids interfering with other
 * plugins that also use `api: 'openai-completions'`.
 *
 * @param getToken      Returns a fresh gcloud/static token
 * @param reregister    Calls pi.registerProvider with the new token so future requests also work
 * @param providerId    The litellm provider ID (default 'litellm') — used to scope gcloud logic
 */
export function createGcloudStreamSimple(
  getToken: () => Promise<string>,
  reregister: (token: string) => void,
  providerId: string = 'litellm',
): StreamSimpleFn {

  // Cast is needed because pi-ai types are the same shape but TypeScript treats
  // the devDep copy and the runtime copy as distinct due to private members.
  return (function gcloudStreamSimple(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream {
    // Only apply gcloud token refresh logic for this provider's models.
    // Other plugins (e.g., pi-provider-tama) also use `api: 'openai-completions'`
    // and would break if forced through gcloud token refresh.
    if (model.provider !== providerId) {
      return streamSimpleOpenAICompletions(model as Model<'openai-completions'>, context, options);
    }

    // Inject x-litellm-session-id so LiteLLM groups all turns of this pi session
    // into a single conversation in the logs/UI — same behaviour as Claude Code.
    const sessionHeaders: Record<string, string> = currentSessionId
      ? { 'x-litellm-session-id': currentSessionId }
      : {}
    const mergedOptions: SimpleStreamOptions = {
      ...options,
      headers: { ...sessionHeaders, ...options?.headers },
    }

    const outerStream = createAssistantMessageEventStream()

    ;(async () => {
      const makeError = (message: string) => ({
        role: 'assistant' as const,
        content: [] as (TextContent | ThinkingContent | ToolCall)[],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'error' as const,
        errorMessage: message,
        timestamp: Date.now(),
      })

      /**
       * Run one streaming attempt with the given token.
       * Returns 'ok' when the stream completes (all events forwarded + outerStream ended).
       * Returns '401' when an auth error is detected — outerStream is NOT ended so caller can retry.
       */
      const runStream = async (token: string): Promise<'ok' | '401'> => {
        let httpStatus = 0

        const inner = streamSimpleOpenAICompletions(model as Model<'openai-completions'>, context, {
          ...mergedOptions,
          apiKey: token,
          onResponse: async (res: { status: number; headers: Record<string, string> }, m: Model<Api>) => {
            httpStatus = res.status
            if (options?.onResponse) {
              await options.onResponse(res, m)
            }
          },
        })

        for await (const event of inner as AsyncIterable<Record<string, unknown>>) {
          if (event['type'] === 'error') {
            const errObj = event['error'] as Record<string, unknown> | undefined
            const errMsg = String(errObj?.['errorMessage'] ?? '')
            const is401 =
              httpStatus === 401 ||
              errMsg.includes('401') ||
              errMsg.toLowerCase().includes('unauthorized') ||
              errMsg.toLowerCase().includes('authentication')

            if (is401) {
              console.warn(`${LOG} 401 detected (httpStatus=${httpStatus}, msg=${errMsg}) — will reset token cache and retry`)
              // Signal 401 without ending the outer stream — caller will retry
              return '401'
            }

            // Non-auth error — forward as-is and finish
            outerStream.push(event as Parameters<typeof outerStream.push>[0])
            outerStream.end()
            return 'ok'
          }

          outerStream.push(event as Parameters<typeof outerStream.push>[0])
        }

        outerStream.end()
        return 'ok'
      }

      try {
        const token = await getToken()
        const result = await runStream(token)

        if (result === '401') {
          console.warn(`${LOG} Resetting token cache and fetching fresh gcloud token`)
          resetTokenCache()
          const freshToken = await getToken()

          if (!freshToken) {
            console.warn(`${LOG} Failed to get fresh token after 401`)
            outerStream.push({ type: 'error', reason: 'error', error: makeError('Failed to refresh gcloud token after 401') })
            outerStream.end()
            return
          }

          console.warn(`${LOG} Got fresh token, re-registering provider and retrying request`)
          // Re-register so the static provider config is also updated for future requests
          reregister(freshToken)

          const retryResult = await runStream(freshToken)
          if (retryResult === '401') {
            console.warn(`${LOG} Retry also got 401 — giving up`)
            outerStream.push({ type: 'error', reason: 'error', error: makeError('Authentication failed after token refresh (401 Unauthorized)') })
            outerStream.end()
          }
        }
      } catch (err) {
        outerStream.push({ type: 'error', reason: 'error', error: makeError(err instanceof Error ? err.message : String(err)) })
        outerStream.end()
      }
    })()

    return outerStream
  }) as unknown as StreamSimpleFn
}
