import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type {
  LiteLLMHealthModel,
  LiteLLMHealthResponse,
  LiteLLMModelInfo,
  McpTool,
  Skill,
  SkillPluginsResponse,
  PluginConfig,
  ProviderModelConfig,
  ProviderConfig,
} from './types.js'

const DISCOVERY_TIMEOUT = 10_000
const TOOL_EXEC_TIMEOUT = 30_000
const SKILL_FETCH_TIMEOUT = 5_000

async function fetchJson<T>(url: string, timeout: number, options?: RequestInit): Promise<T | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)

    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
    })

    clearTimeout(timer)

    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

async function fetchJsonWithStatus<T>(url: string, timeout: number, options?: RequestInit): Promise<{ data: T | null, status: number }> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)

    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
    })

    clearTimeout(timer)

    if (!res.ok) return { data: null, status: res.status }
    return { data: (await res.json()) as T, status: res.status }
  } catch {
    return { data: null, status: 0 }
  }
}

export async function discoverModels(config: PluginConfig, token: string): Promise<Record<string, LiteLLMModelInfo>> {
  // Try /health first (traditional approach), fall back to /v1/model/info
  const { data: healthRes, status: healthStatus } = await fetchJsonWithStatus<LiteLLMHealthResponse>(
    `${config.url}/health`,
    DISCOVERY_TIMEOUT,
    { headers: { 'Authorization': `Bearer ${token}` } }
  )

  if (healthStatus === 403) {
    throw new Error('Access denied (403). Check your LiteLLM API key or contact your admin.')
  }

  // If /health has healthy endpoints, use traditional approach
  if (healthRes?.healthy_endpoints?.length) {
    const infoMap: Record<string, LiteLLMModelInfo> = {}

    const results = await Promise.allSettled(
      healthRes.healthy_endpoints.map(async (endpoint: LiteLLMHealthModel) => {
        const raw = await fetchJson<unknown>(
          `${config.url}/model/info?litellm_model_id=${encodeURIComponent(endpoint.model_id)}`,
          DISCOVERY_TIMEOUT,
          { headers: { 'Authorization': `Bearer ${token}` } }
        )
        return { endpoint, raw }
      })
    )

    for (const result of results) {
      if (result.status !== 'fulfilled') continue
      const { raw } = result.value
      if (!raw || typeof raw !== 'object') continue

      const data = (raw as { data?: unknown[] }).data
      if (!Array.isArray(data) || !data.length) continue
      const entry = data[0] as Record<string, unknown>

      const modelName = typeof entry.model_name === 'string' ? entry.model_name : null
      if (!modelName) continue

      const modelInfo = (entry.model_info ?? {}) as Record<string, unknown>
      const litellmParams = (entry.litellm_params ?? {}) as Record<string, unknown>

      const merged: Record<string, unknown> = {
        model_name: modelName,
        ...modelInfo,
        ...litellmParams,
      }

      if (!merged.max_input_tokens && merged.max_tokens) {
        merged.max_input_tokens = merged.max_tokens
      }
      if (!merged.max_output_tokens && merged.max_tokens) {
        merged.max_output_tokens = merged.max_tokens
      }

      infoMap[modelName] = merged as LiteLLMModelInfo
    }

    return infoMap
  }

  // Fallback: use /v1/model/info to get all models
  const modelInfoRes = await fetchJson<{ data?: unknown[] }>(
    `${config.url}/v1/model/info`,
    DISCOVERY_TIMEOUT,
    { headers: { 'Authorization': `Bearer ${token}` } }
  )

  if (!modelInfoRes?.data || !Array.isArray(modelInfoRes.data)) return {}

  const infoMap: Record<string, LiteLLMModelInfo> = {}

  for (const entry of modelInfoRes.data) {
    if (typeof entry !== 'object' || !entry) continue
    const e = entry as Record<string, unknown>

    const modelName = typeof e.model_name === 'string' ? e.model_name : null
    if (!modelName) continue

    const modelInfo = (e.model_info ?? {}) as Record<string, unknown>
    const litellmParams = (e.litellm_params ?? {}) as Record<string, unknown>

    const merged: Record<string, unknown> = {
      model_name: modelName,
      ...modelInfo,
      ...litellmParams,
    }

    if (!merged.max_input_tokens && merged.max_tokens) {
      merged.max_input_tokens = merged.max_tokens
    }
    if (!merged.max_output_tokens && merged.max_tokens) {
      merged.max_output_tokens = merged.max_tokens
    }

    infoMap[modelName] = merged as LiteLLMModelInfo
  }

  return infoMap
}

export async function discoverMcpTools(config: PluginConfig, token: string): Promise<McpTool[]> {
  const res = await fetchJson<unknown>(
    `${config.url}/mcp-rest/tools/list`,
    DISCOVERY_TIMEOUT,
    { headers: { 'Authorization': `Bearer ${token}` } }
  )
  if (!Array.isArray(res)) return []
  return res as McpTool[]
}

export async function executeMcpTool(
  config: PluginConfig,
  token: string,
  server: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<string> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TOOL_EXEC_TIMEOUT)

    const res = await fetch(`${config.url}/mcp-rest/tools/call`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ server_name: server, tool_name: toolName, arguments: args }),
      signal: controller.signal,
    })

    clearTimeout(timer)

    if (!res.ok) {
      return `Error: HTTP ${res.status} ${res.statusText}`
    }

    const data = await res.json()
    return JSON.stringify(data)
  } catch (err: unknown) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

export async function listSkills(config: PluginConfig, token: string): Promise<Skill[]> {
  const res = await fetchJson<SkillPluginsResponse>(
    `${config.url}/claude-code/plugins`,
    DISCOVERY_TIMEOUT,
    { headers: { 'Authorization': `Bearer ${token}` } }
  )
  return res?.plugins || []
}

export async function registerSkill(
  config: PluginConfig,
  token: string,
  name: string,
  gitUrl: string,
  gitPath: string,
  description?: string,
  domain?: string
): Promise<string> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT)

    const res = await fetch(`${config.url}/claude-code/plugins`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name,
        git_url: gitUrl,
        git_path: gitPath,
        ...(description && { description }),
        ...(domain && { domain }),
      }),
      signal: controller.signal,
    })

    clearTimeout(timer)

    if (!res.ok) {
      return `Error: HTTP ${res.status} ${res.statusText}`
    }

    const data = await res.json()
    return JSON.stringify(data)
  } catch (err: unknown) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

export async function enableSkill(config: PluginConfig, token: string, name: string): Promise<string> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT)

    const res = await fetch(`${config.url}/claude-code/plugins/${encodeURIComponent(name)}/enable`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
      signal: controller.signal,
    })

    clearTimeout(timer)

    if (!res.ok) {
      return `Error: HTTP ${res.status} ${res.statusText}`
    }

    const data = await res.json()
    return JSON.stringify(data)
  } catch (err: unknown) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

export async function disableSkill(config: PluginConfig, token: string, name: string): Promise<string> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT)

    const res = await fetch(`${config.url}/claude-code/plugins/${encodeURIComponent(name)}/disable`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
      signal: controller.signal,
    })

    clearTimeout(timer)

    if (!res.ok) {
      return `Error: HTTP ${res.status} ${res.statusText}`
    }

    const data = await res.json()
    return JSON.stringify(data)
  } catch (err: unknown) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

export async function fetchSkillContent(skill: Skill): Promise<string | null> {
  const { source } = skill
  const { url, path } = source

  // Build GitHub raw URL from git URL
  let rawUrl: string | null = null

  if (url.includes('github.com')) {
    const gitMatch = url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/)
    if (gitMatch) {
      const [, owner, repo] = gitMatch
      const branch = 'main'
      rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}${path ? '/' + path : ''}/SKILL.md`
    }
  }

  if (!rawUrl) return null

  // 2 retries on 429/5xx with exponential backoff
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      const backoff = Math.min(500 * 2 ** (attempt - 1), 1000)
      await new Promise(r => setTimeout(r, backoff))
    }
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), SKILL_FETCH_TIMEOUT)

      const res = await fetch(rawUrl, { signal: controller.signal })
      clearTimeout(timer)

      if (res.ok) {
        return await res.text()
      }

      // Retry on 429 or 5xx
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        continue
      }
      return null
    } catch {
      if (attempt < 2) continue
      return null
    }
  }

  return null
}

export function resolvePluginConfig(): PluginConfig | null {
  // Check env vars first
  const envUrl = process.env.LITELLM_URL
  const envKey = process.env.LITELLM_KEY
  const envGcloudAuth = process.env.LITELLM_GCLOUD_TOKEN_AUTH

  if (envUrl && envKey) {
    return { url: envUrl, apiKey: envKey, providerId: process.env.LITELLM_PROVIDER_ID ?? 'litellm' }
  }

  // Allow missing LITELLM_KEY when gcloud token auth is enabled
  if (envUrl && envGcloudAuth && envGcloudAuth !== '' && envGcloudAuth !== '0') {
    return { url: envUrl, apiKey: envKey ?? '', providerId: process.env.LITELLM_PROVIDER_ID ?? 'litellm' }
  }

  // Check settings.json
  try {
    const settingsPath = path.join(os.homedir(), '.pi', 'agent', 'settings.json')
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>

    const providerSettings = settings['pi-provider-litellm'] as Record<string, string> | undefined

    if (providerSettings?.url && providerSettings?.token) {
      return { url: providerSettings.url, apiKey: providerSettings.token, providerId: providerSettings.providerId ?? 'litellm' }
    }
  } catch {
    // settings.json not found or invalid
  }

  return null
}

export function mapToProviderModel(info: LiteLLMModelInfo): ProviderModelConfig {
  const input: ('text' | 'image')[] = ['text']
  if (info.supports_vision) {
    input.push('image')
  }

  return {
    id: info.model_name ?? '',
    name: info.model_name ?? '',
    reasoning: info.supports_reasoning ?? false,
    input,
    cost: {
      input: info.input_cost_per_token ? info.input_cost_per_token * 1_000_000 : 0,
      output: info.output_cost_per_token ? info.output_cost_per_token * 1_000_000 : 0,
      cacheRead: info.cache_read_input_token_cost ? info.cache_read_input_token_cost * 1_000_000 : 0,
      cacheWrite: info.cache_creation_input_token_cost ? info.cache_creation_input_token_cost * 1_000_000 : 0,
    },
    contextWindow: info.max_input_tokens ?? info.max_tokens ?? 0,
    maxTokens: info.max_output_tokens ?? info.max_tokens ?? 0,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
  }
}

export function buildProviderConfig(
  url: string,
  apiKey: string,
  models: Record<string, LiteLLMModelInfo>
): ProviderConfig {
  const mappedModels = Object.values(models).map(mapToProviderModel)

  return {
    baseUrl: url,
    apiKey,
    api: 'openai-completions',
    models: mappedModels,
  }
}
