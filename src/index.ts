import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { resolvePluginConfig, discoverMcpTools, buildNativeProvider, readSkillsSetting, writeSkillsSetting } from './litellm-api.js'
import { createMcpToolDefinitions, createSkillToolDefinitions } from './tools.js'
import { getGcloudToken } from './gcloud-token.js'
import { createGcloudStreamSimple, setSessionId } from './stream-simple.js'
import type { McpTool, PluginConfig, StreamSimpleFn } from './types.js'
import { syncRemoteSkills, clearSkillsCache, getCachedSkillNames, getCacheAgeMinutes } from './skills-cache.js'

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

  // When gcloud token auth is enabled, fetch a live token instead of using the static apiKey.
  // auth.apiKey.resolve() in buildNativeProvider calls getToken() per-request — no timer needed.
  const getToken = async (): Promise<string> => {
    if (isGcloudAuth) {
      return (await getGcloudToken()) ?? ''
    }
    return config.apiKey
  }

  // In gcloud mode, use a custom streamSimple that fetches a fresh token on every call
  // and retries with a force-refreshed token on 401 errors.
  // Pass providerId so the handler only applies gcloud logic to litellm's own models.
  const streamSimple: StreamSimpleFn | undefined = isGcloudAuth
    ? createGcloudStreamSimple(getToken, config.providerId)
    : undefined

  // Track which tools have been registered to avoid duplicates across session restarts.
  const registeredTools = new Set<string>()

  // Read the skills enabled flag once for startup. Both the remote skills sync
  // and the skill_list tool registration are gated behind this setting.
  const skillsEnabled = readSkillsSetting()

  // Sync remote skills to local cache so pi discovers them natively.
  // Pi scans ~/.pi/agent/skills/ and picks up skills from the remote/ subdirectory.
  if (skillsEnabled) {
    await syncRemoteSkills(config.url, getToken, (msg) => console.log(msg))
  }

  // Register the native provider — pi owns the model cache and refresh lifecycle.
  // fetchModels is called by pi on startup (restoring from models-store.json) and on refresh.
  // auth.apiKey.resolve() is called per-request so gcloud tokens stay fresh automatically.
  const provider = buildNativeProvider(config, isGcloudAuth, getToken, streamSimple)
  pi.registerProvider(provider)

  // Initial MCP tool and skills discovery
  await discoverAndRegisterTools(pi, config, getToken, registeredTools, skillsEnabled)

  pi.on('session_start', async (_event, ctx) => {
    // Assign a stable session ID so all requests in this pi session are grouped
    // under one conversation in the LiteLLM logs — mirroring Claude Code behaviour.
    setSessionId(ctx.sessionManager.getSessionId() ?? crypto.randomUUID())

    // Re-read the setting fresh each time so enabling skills via /litellm-skills on
    // during a session is picked up on the next session_start.
    const sessionSkillsEnabled = readSkillsSetting()
    await discoverAndRegisterTools(pi, config, getToken, registeredTools, sessionSkillsEnabled)
  })

  pi.on('session_shutdown', async (_event, _ctx) => {
    setSessionId(undefined)
  })

  pi.registerCommand('litellm-skills', {
    description: 'Toggle remote skill syncing: on | off | status',
    handler: async (args: string, ctx) => {
      const sub = args.trim().toLowerCase()

      if (sub === 'on') {
        writeSkillsSetting(true)
        ctx.ui.notify('Skills enabled — syncing now…', 'info')
        await syncRemoteSkills(config.url, getToken, (msg) => console.log(msg))
        // Register the skill_list tool immediately so it's available without restart
        await discoverAndRegisterTools(pi, config, getToken, registeredTools, true)
        const names = getCachedSkillNames()
        ctx.ui.notify(`Skills ready: ${names.length} skills cached`, 'info')
        return
      }

      if (sub === 'off') {
        writeSkillsSetting(false)
        clearSkillsCache()
        ctx.ui.notify('Skills disabled — cache cleared. The skill_list tool will be removed on next restart.', 'info')
        return
      }

      if (sub === 'status') {
        const enabled = readSkillsSetting()
        const names = getCachedSkillNames()
        const ageMin = getCacheAgeMinutes()
        const ageStr = ageMin !== null ? `${ageMin}m ago` : 'n/a'
        const lines = [
          `Skills: ${enabled ? '✅ enabled' : '❌ disabled'}`,
          `Cached skills: ${names.length}`,
          `Cache age: ${ageStr}`,
        ]
        ctx.ui.notify(lines.join('\n'), 'info')
        return
      }

      // No args or unrecognised
      ctx.ui.notify('Usage: /litellm-skills on | off | status', 'info')
    },
  })
}

/**
 * Discover MCP tools and skills and register them with pi.
 * Called at startup and on session_start. Model discovery is handled by pi
 * via the createProvider fetchModels callback — not called here.
 */
export async function discoverAndRegisterTools(
  pi: ExtensionAPI,
  config: PluginConfig,
  getToken: () => Promise<string>,
  registeredTools?: Set<string>,
  skillsEnabled?: boolean,
): Promise<void> {
  const token = await getToken()

  const DISCOVERY_TIMEOUT_MS = 30_000
  let mcpResult: PromiseSettledResult<McpTool[]>

  const timeoutTimer = setTimeout(() => {}, DISCOVERY_TIMEOUT_MS) // placeholder for signal

  try {
    const results = await Promise.allSettled([
      discoverMcpTools(config, token),
    ])
    mcpResult = results[0] as PromiseSettledResult<McpTool[]>
  } catch (error) {
    mcpResult = { status: 'rejected', reason: error as Error }
  } finally {
    clearTimeout(timeoutTimer)
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

  if (skillsEnabled) {
    const skillTools = createSkillToolDefinitions()
    for (const tool of skillTools) {
      if (!registeredTools || !registeredTools.has(tool.name)) {
        pi.registerTool(tool)
        registeredTools?.add(tool.name)
      }
    }
  }
}
