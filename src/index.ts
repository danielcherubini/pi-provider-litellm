import type { ExtensionAPI, BeforeAgentStartEvent, BeforeAgentStartEventResult } from '@earendil-works/pi-coding-agent'
import { resolvePluginConfig, discoverModels, discoverMcpTools, listSkills, buildProviderConfig } from './litellm-api.js'
import { createMcpToolDefinitions, createSkillToolDefinitions, createSkillsInjector } from './tools.js'
import { getGcloudToken } from './gcloud-token.js'
import type { LiteLLMModelInfo, McpTool, PluginConfig } from './types.js'

export default async function (pi: ExtensionAPI): Promise<void> {
  const config = resolvePluginConfig()
  if (!config) {
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
  try {
    pi.unregisterProvider(config.providerId)
  } catch {
    // Provider not yet registered
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

  if (modelsResult.status === 'fulfilled' && Object.keys(modelsResult.value).length > 0) {
    const token = await getToken()
    const providerConfig = buildProviderConfig(config.url, token, modelsResult.value)
    pi.registerProvider(config.providerId, providerConfig)
  }

  if (mcpResult.status === 'fulfilled') {
    const mcpTools = createMcpToolDefinitions(config, getToken, mcpResult.value)
    for (const tool of mcpTools) {
      pi.registerTool(tool)
    }
  }

  const skillTools = createSkillToolDefinitions(config, getToken)
  for (const tool of skillTools) {
    pi.registerTool(tool)
  }
}
