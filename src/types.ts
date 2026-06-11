import type { ProviderModelConfig, ProviderConfig } from '@earendil-works/pi-coding-agent'

export type { ProviderModelConfig, ProviderConfig }

/** The streamSimple signature as expected by pi's ProviderConfig. */
export type StreamSimpleFn = NonNullable<ProviderConfig['streamSimple']>

// LiteLLM /health endpoint response
export interface LiteLLMHealthModel {
  model: string
  model_id: string
}

export interface LiteLLMHealthResponse {
  healthy_endpoints?: LiteLLMHealthModel[]
}

// LiteLLM /model/info response
export interface LiteLLMModelInfo {
  model_name?: string
  max_tokens?: number
  max_input_tokens?: number
  max_output_tokens?: number
  supports_function_calling?: boolean
  supports_reasoning?: boolean
  supports_vision?: boolean
  supports_audio_input?: boolean
  supports_pdf_input?: boolean
  input_cost_per_token?: number
  output_cost_per_token?: number
  cache_read_input_token_cost?: number
  cache_creation_input_token_cost?: number
}

// MCP tool from /mcp-rest/tools/list
export interface McpTool {
  name: string
  server_name: string
  description: string
  input_schema: Record<string, unknown>
}

// Skill types from /claude-code/plugins
export interface SkillSource {
  source: string
  url: string
  path?: string
}

export interface Skill {
  id: string
  name: string
  version: string
  description: string | null
  source: SkillSource
  author: string | null
  homepage: string | null
  keywords: string | null
  category: string | null
  domain: string | null
  namespace: string | null
  enabled: boolean
  created_at: string
  updated_at: string
}

export interface SkillPluginsResponse {
  plugins?: Skill[]
}

// Plugin config resolved from env or settings
export interface PluginConfig {
  url: string
  apiKey: string
  providerId: string
}
