import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createProvider, type Provider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/compat'
import type { ProviderAuth, Model } from '@earendil-works/pi-ai'
import type {
  LiteLLMHealthModel,
  LiteLLMHealthResponse,
  LiteLLMModelInfo,
  McpTool,
  PluginConfig,
  ProviderModelConfig,
  StreamSimpleFn,
} from './types.js'

const DISCOVERY_TIMEOUT = 10_000
const TOOL_EXEC_TIMEOUT = 30_000

// Fields from litellm_params that may contain secrets or deployment details
// and should not be persisted to the disk cache.
const SENSITIVE_PARAM_KEYS = new Set([
  'api_key', 'api_base', 'api_version', 'base_model',
  'vertex_project', 'vertex_location', 'vertex_credentials',
  'aws_access_key_id', 'aws_secret_access_key', 'aws_region_name',
])

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
  // Primary: use /v1/model/info — single call, returns all models with full metadata
  const modelInfoRes = await fetchJson<{ data?: unknown[] }>(
    `${config.url}/v1/model/info`,
    DISCOVERY_TIMEOUT,
    { headers: { 'Authorization': `Bearer ${token}` } }
  )

  if (modelInfoRes?.data && Array.isArray(modelInfoRes.data) && modelInfoRes.data.length > 0) {
    const infoMap: Record<string, LiteLLMModelInfo> = {}

    for (const entry of modelInfoRes.data) {
      if (typeof entry !== 'object' || !entry) continue
      const e = entry as Record<string, unknown>

      const modelName = typeof e.model_name === 'string' ? e.model_name : null
      if (!modelName) continue

      const modelInfo = (e.model_info ?? {}) as Record<string, unknown>
      const litellmParams = (e.litellm_params ?? {}) as Record<string, unknown>

      infoMap[modelName] = mergeModelInfo(modelName, modelInfo, litellmParams)
    }

    return infoMap
  }

  // Fallback: use /health + /model/info per model (legacy approach)
  const { data: healthRes, status } = await fetchJsonWithStatus<LiteLLMHealthResponse>(
    `${config.url}/health`,
    DISCOVERY_TIMEOUT,
    { headers: { 'Authorization': `Bearer ${token}` } }
  )

  if (status === 403) {
    throw new Error('Access denied (403). Check your LiteLLM API key or contact your admin.')
  }

  if (!healthRes || !healthRes.healthy_endpoints?.length) return {}

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

    infoMap[modelName] = mergeModelInfo(modelName, modelInfo, litellmParams)
  }

  return infoMap
}

function mergeModelInfo(
  modelName: string,
  modelInfo: Record<string, unknown>,
  litellmParams: Record<string, unknown>,
): LiteLLMModelInfo {
  // Strip sensitive deployment/credential fields from litellm_params
  // before merging — these should never be persisted to the disk cache.
  const safeParams: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(litellmParams)) {
    if (!SENSITIVE_PARAM_KEYS.has(k)) {
      safeParams[k] = v
    }
  }

  const merged: Record<string, unknown> = {
    model_name: modelName,
    ...modelInfo,
    ...safeParams,
  }

  if (merged.max_input_tokens == null && merged.max_tokens != null) {
    merged.max_input_tokens = merged.max_tokens
  }
  if (merged.max_output_tokens == null && merged.max_tokens != null) {
    merged.max_output_tokens = merged.max_tokens
  }

  return merged as LiteLLMModelInfo
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

/**
 * Read the skills enabled flag from ~/.pi/agent/settings.json.
 * Returns false if the file is missing, unreadable, or the flag is not explicitly true.
 */
export function readSkillsSetting(): boolean {
  try {
    const settingsPath = path.join(os.homedir(), '.pi', 'agent', 'settings.json')
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
    const litellm = settings['litellm']
    if (typeof litellm !== 'object' || litellm === null) return false
    return (litellm as Record<string, unknown>)['skills'] === true
  } catch {
    return false
  }
}

/**
 * Write the skills enabled flag to ~/.pi/agent/settings.json.
 * Reads the existing file, merges the litellm.skills key, and writes it back.
 * Preserves all other existing settings. Guards against non-object litellm value.
 */
export function writeSkillsSetting(enabled: boolean): void {
  const settingsPath = path.join(os.homedir(), '.pi', 'agent', 'settings.json')
  let settings: Record<string, unknown> = {}
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
  } catch {
    // File missing or unreadable — start fresh
  }
  const existing = settings['litellm']
  const litellm: Record<string, unknown> =
    typeof existing === 'object' && existing !== null
      ? { ...(existing as Record<string, unknown>) }
      : {}
  settings['litellm'] = { ...litellm, skills: enabled }
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
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

export function toNativeModel(
  pc: ProviderModelConfig,
  providerId: string,
  baseUrl: string,
): Model<'openai-completions'> {
  return {
    id: pc.id,
    name: pc.name,
    api: 'openai-completions',
    provider: providerId,
    baseUrl,
    reasoning: pc.reasoning,
    input: pc.input,
    cost: pc.cost,
    contextWindow: pc.contextWindow,
    maxTokens: pc.maxTokens,
    ...(pc.compat !== undefined ? { compat: pc.compat } : {}),
  }
}

export function buildNativeProvider(
  config: PluginConfig,
  isGcloudAuth: boolean,
  getToken: () => Promise<string>,
  streamSimple?: StreamSimpleFn,
): Provider<'openai-completions'> {
  const auth: ProviderAuth = {
    apiKey: {
      name: 'LiteLLM API key',
      // resolve() is called per-request by pi to obtain the Bearer token.
      // We intentionally ignore `input` — our auth is ambient (gcloud ADC or env var),
      // not stored in pi's auth.json.
      async resolve() {
        const key = await getToken()
        if (!key) return undefined
        return {
          auth: { apiKey: key },
          source: isGcloudAuth ? 'gcloud ADC' : 'LITELLM_KEY',
        }
      },
    },
  }

  const baseApi = openAICompletionsApi()
  const api = streamSimple ? { ...baseApi, streamSimple } : baseApi

  return createProvider({
    id: config.providerId,
    name: 'LiteLLM',
    baseUrl: config.url,
    auth,
    models: [],
    api,
    fetchModels: async (context) => {
      if (!context.allowNetwork) return []
      // Prefer pi's resolved credential key if available; fall back to direct token fetch.
      // Our resolve() is ambient-only so context.credential will typically be undefined.
      const token = (context.credential as { key?: string } | undefined)?.key ?? await getToken()
      const raw = await discoverModels(config, token)
      return Object.values(raw).map(info =>
        toNativeModel(mapToProviderModel(info), config.providerId, config.url)
      )
    },
  })
}
