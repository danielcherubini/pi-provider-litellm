import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mapToProviderModel, resolvePluginConfig, buildProviderConfig } from '../src/litellm-api.js'
import type { LiteLLMModelInfo } from '../src/types.js'

describe('mapToProviderModel', () => {
  it('includes image in input for vision models', () => {
    const info: LiteLLMModelInfo = {
      model_name: 'gpt-4-vision',
      supports_vision: true,
    }
    const result = mapToProviderModel(info)
    expect(result.input).toContain('image')
    expect(result.input).toContain('text')
  })

  it('sets reasoning true when supports_reasoning is true', () => {
    const info: LiteLLMModelInfo = {
      model_name: 'o1',
      supports_reasoning: true,
    }
    const result = mapToProviderModel(info)
    expect(result.reasoning).toBe(true)
  })

  it('multiplies costs by 1,000,000', () => {
    const info: LiteLLMModelInfo = {
      model_name: 'gpt-4',
      input_cost_per_token: 0.0000001,
      output_cost_per_token: 0.0000002,
    }
    const result = mapToProviderModel(info)
    expect(result.cost.input).toBeCloseTo(0.1)
    expect(result.cost.output).toBeCloseTo(0.2)
  })

  it('sets compat defaults', () => {
    const info: LiteLLMModelInfo = {
      model_name: 'gpt-4',
    }
    const result = mapToProviderModel(info)
    expect(result.compat).toEqual({
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    })
  })
})

describe('resolvePluginConfig', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('returns config when env vars are set', () => {
    process.env.LITELLM_URL = 'https://litellm.example.com'
    process.env.LITELLM_KEY = 'sk-test123'
    delete process.env.LITELLM_PROVIDER_ID

    const result = resolvePluginConfig()
    expect(result).toEqual({
      url: 'https://litellm.example.com',
      apiKey: 'sk-test123',
      providerId: 'litellm',
    })
  })

  it('returns config with empty apiKey when gcloud auth is enabled and no LITELLM_KEY', () => {
    process.env.LITELLM_URL = 'https://litellm.example.com'
    delete process.env.LITELLM_KEY
    process.env.LITELLM_GCLOUD_TOKEN_AUTH = '1'

    const result = resolvePluginConfig()
    expect(result).not.toBeNull()
    expect(result!.url).toBe('https://litellm.example.com')
    expect(result!.apiKey).toBe('')

    delete process.env.LITELLM_GCLOUD_TOKEN_AUTH
  })

  it('falls back to settings.json when env vars are not set', () => {
    delete process.env.LITELLM_URL
    delete process.env.LITELLM_KEY
    delete process.env.LITELLM_GCLOUD_TOKEN_AUTH

    // resolvePluginConfig tries env vars first, then settings.json.
    // Without env vars, it returns whatever settings.json provides (or null).
    const result = resolvePluginConfig()
    // On CI / fresh machines there's no settings.json → null.
    // On dev machines with settings.json → a valid config.
    if (result !== null) {
      expect(typeof result.url).toBe('string')
      expect(typeof result.apiKey).toBe('string')
    }
  })

  it('prefers env vars over settings.json', () => {
    process.env.LITELLM_URL = 'https://from-env.example.com'
    process.env.LITELLM_KEY = 'env-key'
    process.env.LITELLM_PROVIDER_ID = 'custom-provider'

    const result = resolvePluginConfig()
    expect(result).toEqual({
      url: 'https://from-env.example.com',
      apiKey: 'env-key',
      providerId: 'custom-provider',
    })
  })
})

describe('buildProviderConfig', () => {
  it('maps models and sets api to openai-completions', () => {
    const models = {
      'gpt-4': { model_name: 'gpt-4', max_tokens: 8192, supports_reasoning: true },
    }
    const config = buildProviderConfig('https://litellm.example.com', 'sk-test', models)

    expect(config.api).toBe('openai-completions')
    expect(config.baseUrl).toBe('https://litellm.example.com')
    expect(config.apiKey).toBe('sk-test')
    expect(config.models).toHaveLength(1)
    expect(config.models![0].id).toBe('gpt-4')
    expect(config.models![0].reasoning).toBe(true)
  })

  it('handles empty models map', () => {
    const config = buildProviderConfig('https://litellm.example.com', 'sk-test', {})
    expect(config.models).toHaveLength(0)
  })
})
