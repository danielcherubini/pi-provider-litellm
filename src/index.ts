import type { ExtensionAPI, BeforeAgentStartEvent, BeforeAgentStartEventResult } from '@earendil-works/pi-coding-agent'
import { resolvePluginConfig, discoverModels, discoverMcpTools, listSkills, buildProviderConfig } from './litellm-api.js'
import { createMcpToolDefinitions, createSkillToolDefinitions, createSkillsInjector } from './tools.js'
import { getGcloudToken } from './gcloud-token.js'
import { loadModelCache, saveModelCache } from './model-cache.js'
import type { LiteLLMModelInfo, McpTool, PluginConfig } from './types.js'

const LOG = '[pi-provider-litellm]'

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

  // Await discovery so PI blocks until models are registered before resolving
  // model patterns. Cache is loaded at the top of discoverAndRegister so the
  // first call returns quickly on subsequent startups.
  await discoverAndRegister(pi, config, getToken)

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

  pi.on('session_start', async (_event, _ctx) => {
    setupCompleteSessions.clear()
    injector.clearCache()
    await discoverAndRegister(pi, config, getToken)
  })

  pi.on('session_shutdown', async (_event, _ctx) => {
    injector.clearCache()
  })
}

export async function discoverAndRegister(pi: ExtensionAPI, config: PluginConfig, getToken: () => Promise<string>): Promise<void> {
  // Register from cache immediately so models are visible before live discovery
  // completes. On first-ever run there is no cache, so this is a no-op.
  const cached = loadModelCache(config.providerId)
  if (cached) {
    pi.registerProvider(config.providerId, buildProviderConfig(config.url, config.apiKey, cached))
  }

  const DISCOVERY_TIMEOUT_MS = 30_000

  let modelsResult: PromiseSettledResult<Record<string, LiteLLMModelInfo>>
  let mcpResult: PromiseSettledResult<McpTool[]>

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('Discovery timeout')), DISCOVERY_TIMEOUT_MS)
  })

  try {
    const token = await getToken()
    const results = await Promise.race([
      Promise.allSettled([
        discoverModels(config, token),
        discoverMcpTools(config, token),
        listSkills(config, token),
      ]),
      timeoutPromise,
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
  }

  if (modelsResult.status === 'fulfilled') {
    const modelCount = Object.keys(modelsResult.value).length
    if (modelCount > 0) {
      saveModelCache(config.providerId, modelsResult.value)
      const token = await getToken()
      const providerConfig = buildProviderConfig(config.url, token, modelsResult.value)
      pi.registerProvider(config.providerId, providerConfig)
    } else {
      console.warn(`${LOG} No models discovered — check LiteLLM /health endpoint`)
    }
  } else {
    console.error(`${LOG} Model discovery error: ${modelsResult.reason}`)
  }

  if (mcpResult.status === 'fulfilled') {
    const mcpTools = createMcpToolDefinitions(config, getToken, mcpResult.value)
    for (const tool of mcpTools) {
      pi.registerTool(tool)
    }
  } else {
    console.warn(`${LOG} MCP tool discovery failed: ${mcpResult.reason}`)
  }

  const skillTools = createSkillToolDefinitions(config, getToken)
  for (const tool of skillTools) {
    pi.registerTool(tool)
  }
}
