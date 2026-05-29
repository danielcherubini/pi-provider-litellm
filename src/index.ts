import type { ExtensionAPI, BeforeAgentStartEvent, BeforeAgentStartEventResult } from '@earendil-works/pi-coding-agent'
import { resolvePluginConfig, discoverModels, discoverMcpTools, listSkills, buildProviderConfig } from './litellm-api.js'
import { createMcpToolDefinitions, createSkillToolDefinitions, createSkillsInjector } from './tools.js'
import type { LiteLLMModelInfo, McpTool, PluginConfig } from './types.js'

const PROVIDER_NAME = 'litellm'

export default async function (pi: ExtensionAPI): Promise<void> {
  console.log('[pi-provider-litellm] Extension loaded, starting discovery...')
  const config = resolvePluginConfig()
  if (!config) {
    console.log('[pi-provider-litellm] No LiteLLM config found. Set LITELLM_URL/LITELLM_KEY or ~/.pi/agent/settings.json')
    return
  }

  console.log(`[pi-provider-litellm] Config resolved: url=${config.url}`)
  await discoverAndRegister(pi, config)

  const injector = createSkillsInjector(config, config.apiKey)
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
    await discoverAndRegister(pi, config)
  })

  pi.on('session_shutdown', async (_event, _ctx) => {
    injector.clearCache()
  })
}

export async function discoverAndRegister(pi: ExtensionAPI, config: PluginConfig): Promise<void> {
  pi.unregisterProvider(PROVIDER_NAME)

  const DISCOVERY_TIMEOUT_MS = 30_000

  let modelsResult: PromiseSettledResult<Record<string, LiteLLMModelInfo>>
  let mcpResult: PromiseSettledResult<McpTool[]>

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('Discovery timeout')), DISCOVERY_TIMEOUT_MS)
  })

  try {
    const results = await Promise.race([
      Promise.allSettled([
        discoverModels(config, config.apiKey),
        discoverMcpTools(config, config.apiKey),
        listSkills(config, config.apiKey),
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
    console.warn(`[pi-provider-litellm] Discovery failed: ${error}`)
    modelsResult = { status: 'rejected', reason: error as Error }
    mcpResult = { status: 'rejected', reason: error as Error }
  }

  if (modelsResult.status === 'fulfilled' && Object.keys(modelsResult.value).length > 0) {
    const providerConfig = buildProviderConfig(config.url, config.apiKey, modelsResult.value)
    pi.registerProvider(PROVIDER_NAME, providerConfig)
    console.log(`[pi-provider-litellm] Registered ${Object.keys(modelsResult.value).length} models`)
  } else if (modelsResult.status === 'rejected') {
    console.warn(`[pi-provider-litellm] Model discovery failed: ${modelsResult.reason}`)
  }

  if (mcpResult.status === 'fulfilled') {
    const mcpTools = createMcpToolDefinitions(config, config.apiKey, mcpResult.value)
    for (const tool of mcpTools) {
      pi.registerTool(tool)
    }
    if (mcpTools.length > 0) {
      console.log(`[pi-provider-litellm] Registered ${mcpTools.length} MCP tools`)
    }
  } else {
    console.warn(`[pi-provider-litellm] MCP tool discovery failed: ${mcpResult.reason}`)
  }

  const skillTools = createSkillToolDefinitions(config, config.apiKey)
  for (const tool of skillTools) {
    pi.registerTool(tool)
  }
}
