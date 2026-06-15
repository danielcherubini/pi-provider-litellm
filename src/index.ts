import type { ExtensionAPI, BeforeAgentStartEvent, BeforeAgentStartEventResult } from '@earendil-works/pi-coding-agent'
import { resolvePluginConfig, discoverModels, discoverMcpTools, listSkills, buildProviderConfig } from './litellm-api.js'
import { createMcpToolDefinitions, createSkillToolDefinitions, createSkillsInjector } from './tools.js'
import { getGcloudToken } from './gcloud-token.js'
import { loadModelCache, saveModelCache } from './model-cache.js'
import { createGcloudStreamSimple, setSessionId } from './stream-simple.js'
import type { LiteLLMModelInfo, McpTool, PluginConfig, StreamSimpleFn } from './types.js'

const LOG = '[pi-provider-litellm]'
// Re-register the provider every 45 minutes to pick up a fresh gcloud OAuth token
// (Google OAuth tokens expire after ~60 minutes)
const TOKEN_REFRESH_INTERVAL_MS = 45 * 60 * 1000

export default async function (pi: ExtensionAPI): Promise<void> {
  const config = resolvePluginConfig()
  if (!config) {
    console.warn(`${LOG} No config found — set LITELLM_URL and LITELLM_KEY (or LITELLM_GCLOUD_TOKEN_AUTH=1)`)
    return
  }

  const isGcloudAuth = !!(process.env.LITELLM_GCLOUD_TOKEN_AUTH &&
    process.env.LITELLM_GCLOUD_TOKEN_AUTH !== '' &&
    process.env.LITELLM_GCLOUD_TOKEN_AUTH !== '0')

  // When gcloud token auth is enabled, fetch a live token instead of using the static apiKey
  const getToken = async (): Promise<string> => {
    if (isGcloudAuth) {
      return (await getGcloudToken()) ?? ''
    }
    return config.apiKey
  }

  // Re-register the provider with a fresh token (used by the streamSimple 401 handler)
  const reregister = (token: string): void => {
    const models = loadModelCache(config.providerId)
    if (models) {
      pi.registerProvider(config.providerId, buildProviderConfig(config.url, token, models, streamSimple))
    }
  }

  // In gcloud mode, use a custom streamSimple that fetches a fresh token on every call
  // and retries with a force-refreshed token on 401 errors.
  // Pass providerId so the handler only applies gcloud logic to litellm's own models.
  const streamSimple: StreamSimpleFn | undefined = isGcloudAuth
    ? createGcloudStreamSimple(getToken, reregister, config.providerId)
    : undefined

  // Track which tools have been registered to avoid duplicates across session restarts.
  const registeredTools = new Set<string>()

  // Await discovery so PI blocks until models are registered before resolving
  // model patterns. Cache is loaded at the top of discoverAndRegister so the
  // first call returns quickly on subsequent startups.
  await discoverAndRegister(pi, config, getToken, streamSimple, registeredTools)

  const injector = createSkillsInjector(config, getToken)
  const setupCompleteSessions = new Set<string>()
  pi.on('before_agent_start', async (event: BeforeAgentStartEvent, ctx): Promise<BeforeAgentStartEventResult> => {
    const sessionId = ctx.sessionManager.getSessionFile()
    if (sessionId && setupCompleteSessions.has(sessionId)) return {}
    if (sessionId) setupCompleteSessions.add(sessionId)

    const summary = await injector.getSkillsSummary()
    if (!summary) return {}
    return { systemPrompt: event.systemPrompt + '\n\n' + summary }
  })

  pi.on('session_start', async (_event, ctx) => {
    // Assign a stable session ID so all requests in this pi session are grouped
    // under one conversation in the LiteLLM logs — mirroring Claude Code behaviour.
    // getSessionId() returns the UUID from the session header directly.
    setSessionId(ctx.sessionManager.getSessionId() ?? crypto.randomUUID())

    setupCompleteSessions.clear()
    injector.clearCache()
    await discoverAndRegister(pi, config, getToken, streamSimple, registeredTools)
  })

  pi.on('session_shutdown', async (_event, _ctx) => {
    setSessionId(undefined)
    injector.clearCache()
  })

  // Periodically refresh the provider registration with a fresh token.
  // Google OAuth access tokens expire after ~60 minutes, so we re-register
  // every 45 minutes to stay ahead of expiry. The streamSimple handler also
  // handles reactive 401 recovery on each individual request.
  if (isGcloudAuth) {
    const refreshTimer = setInterval(async () => {
      try {
        const token = await getToken()
        if (token) {
          const models = loadModelCache(config.providerId)
          if (models) {
            pi.registerProvider(config.providerId, buildProviderConfig(config.url, token, models, streamSimple))
          }
        }
      } catch (err) {
        console.warn(`${LOG} Token refresh failed: ${err}`)
      }
    }, TOKEN_REFRESH_INTERVAL_MS)

    // Ensure the timer doesn't keep the process alive if PI shuts down
    if (refreshTimer.unref) {
      refreshTimer.unref()
    }
  }
}

export async function discoverAndRegister(
  pi: ExtensionAPI,
  config: PluginConfig,
  getToken: () => Promise<string>,
  streamSimple?: StreamSimpleFn,
  registeredTools?: Set<string>,
): Promise<void> {
  // Fetch one token up-front and reuse it for all registrations in this call.
  const token = await getToken()

  // Register from cache before live discovery so models are visible immediately.
  const cached = loadModelCache(config.providerId)
  if (cached) {
    pi.registerProvider(config.providerId, buildProviderConfig(config.url, token, cached, streamSimple))
  }

  const DISCOVERY_TIMEOUT_MS = 30_000

  let modelsResult: PromiseSettledResult<Record<string, LiteLLMModelInfo>>
  let mcpResult: PromiseSettledResult<McpTool[]>

  const controller = new AbortController()
  const timeoutTimer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS)

  try {
    const results = await Promise.allSettled([
      discoverModels(config, token),
      discoverMcpTools(config, token),
      listSkills(config, token),
    ])

    const settledResults = results as [
      PromiseSettledResult<Record<string, LiteLLMModelInfo>>,
      PromiseSettledResult<McpTool[]>,
      PromiseSettledResult<unknown>,
    ]
    modelsResult = settledResults[0]
    mcpResult = settledResults[1]
  } catch (error) {
    modelsResult = { status: 'rejected', reason: error as Error }
    mcpResult = { status: 'rejected', reason: error as Error }
  } finally {
    clearTimeout(timeoutTimer)
  }

  if (modelsResult.status === 'fulfilled') {
    const modelCount = Object.keys(modelsResult.value).length
    if (modelCount > 0) {
      saveModelCache(config.providerId, modelsResult.value)
      const providerConfig = buildProviderConfig(config.url, token, modelsResult.value, streamSimple)
      pi.registerProvider(config.providerId, providerConfig)
    } else {
      console.warn(`${LOG} No models discovered — check LiteLLM /v1/model/info endpoint (URL: ${config.url})`)
    }
  } else {
    console.error(`${LOG} Model discovery error: ${modelsResult.reason}`)
  }

  if (mcpResult.status === 'fulfilled') {
    const mcpTools = createMcpToolDefinitions(config, getToken, mcpResult.value)
    for (const tool of mcpTools) {
      if (!registeredTools || !registeredTools.has(tool.name)) {
        pi.registerTool(tool)
        registeredTools?.add(tool.name)
      }
    }
  } else {
    console.warn(`${LOG} MCP tool discovery failed: ${mcpResult.reason}`)
  }

  const skillTools = createSkillToolDefinitions(config, getToken)
  for (const tool of skillTools) {
    if (!registeredTools || !registeredTools.has(tool.name)) {
      pi.registerTool(tool)
      registeredTools?.add(tool.name)
    }
  }
}
