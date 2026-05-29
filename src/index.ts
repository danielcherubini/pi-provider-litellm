import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ExtensionAPI, BeforeAgentStartEvent, BeforeAgentStartEventResult } from '@earendil-works/pi-coding-agent'
import { resolvePluginConfig, discoverModels, discoverMcpTools, listSkills, buildProviderConfig } from './litellm-api.js'
import { createMcpToolDefinitions, createSkillToolDefinitions, createSkillsInjector } from './tools.js'
import type { LiteLLMModelInfo, McpTool, PluginConfig } from './types.js'

const PROVIDER_NAME = 'litellm'
const LOG_FILE = path.join(os.homedir(), '.pi', 'agent', 'pi-provider-litellm.log')

function log(msg: string) {
  const line = `[pi-provider-litellm] ${new Date().toISOString()} ${msg}\n`
  fs.appendFileSync(LOG_FILE, line)
  console.log(line.trim())
}

export default async function (pi: ExtensionAPI): Promise<void> {
  log('Extension loaded, starting discovery...')
  const config = resolvePluginConfig()
  if (!config) {
    log('No LiteLLM config found. Set LITELLM_URL/LITELLM_KEY or ~/.pi/agent/settings.json')
    return
  }

  log(`Config resolved: url=${config.url}`)
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
  log('discoverAndRegister: starting...')
  try {
    pi.unregisterProvider(PROVIDER_NAME)
  } catch (e) {
    log(`unregisterProvider failed: ${e}`)
  }

  const DISCOVERY_TIMEOUT_MS = 30_000

  let modelsResult: PromiseSettledResult<Record<string, LiteLLMModelInfo>>
  let mcpResult: PromiseSettledResult<McpTool[]>

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('Discovery timeout')), DISCOVERY_TIMEOUT_MS)
  })

  try {
    log('discoverAndRegister: running discovery...')
    const results = await Promise.race([
      Promise.allSettled([
        discoverModels(config, config.apiKey),
        discoverMcpTools(config, config.apiKey),
        listSkills(config, config.apiKey),
      ]),
      timeoutPromise,
    ])
    log(`discoverAndRegister: discovery done, modelsResult.status=${results[0].status}`)
    const settledResults = results as [
      PromiseSettledResult<Record<string, LiteLLMModelInfo>>,
      PromiseSettledResult<McpTool[]>,
      PromiseSettledResult<unknown>,
    ]
    modelsResult = settledResults[0]
    mcpResult = settledResults[1]
  } catch (error) {
    log(`Discovery failed: ${error}`)
    modelsResult = { status: 'rejected', reason: error as Error }
    mcpResult = { status: 'rejected', reason: error as Error }
  }

  if (modelsResult.status === 'fulfilled' && Object.keys(modelsResult.value).length > 0) {
    const providerConfig = buildProviderConfig(config.url, config.apiKey, modelsResult.value)
    pi.registerProvider(PROVIDER_NAME, providerConfig)
    log(`Registered ${Object.keys(modelsResult.value).length} models`)
  } else if (modelsResult.status === 'rejected') {
    log(`Model discovery failed: ${modelsResult.reason}`)
  } else {
    log('No models discovered (empty result)')
  }

  if (mcpResult.status === 'fulfilled') {
    const mcpTools = createMcpToolDefinitions(config, config.apiKey, mcpResult.value)
    for (const tool of mcpTools) {
      pi.registerTool(tool)
    }
    if (mcpTools.length > 0) {
      log(`Registered ${mcpTools.length} MCP tools`)
    }
  } else {
    log(`MCP tool discovery failed: ${mcpResult.reason}`)
  }

  const skillTools = createSkillToolDefinitions(config, config.apiKey)
  for (const tool of skillTools) {
    pi.registerTool(tool)
  }
  log(`Registered ${skillTools.length} skill tools`)
}
