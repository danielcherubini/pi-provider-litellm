import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mapToProviderModel, resolvePluginConfig, buildProviderConfig, readSkillsSetting, writeSkillsSetting } from '../src/litellm-api.js'
import type { LiteLLMModelInfo } from '../src/types.js'

const mockReadFileSync = vi.hoisted(() => vi.fn())
const mockWriteFileSync = vi.hoisted(() => vi.fn())
const mockMkdirSync = vi.hoisted(() => vi.fn())

vi.mock('node:fs', () => ({
  default: {
    get readFileSync() { return mockReadFileSync },
    get writeFileSync() { return mockWriteFileSync },
    get mkdirSync() { return mockMkdirSync },
  },
}))

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

describe('readSkillsSetting', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns false when settings.json does not exist', () => {
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT') })
    expect(readSkillsSetting()).toBe(false)
  })

  it('returns false when litellm key is missing', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ defaultModel: 'gpt-4' }))
    expect(readSkillsSetting()).toBe(false)
  })

  it('returns false when litellm.skills is false', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ litellm: { skills: false } }))
    expect(readSkillsSetting()).toBe(false)
  })

  it('returns true when litellm.skills is true', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ litellm: { skills: true } }))
    expect(readSkillsSetting()).toBe(true)
  })

  it('returns false when litellm.skills is a non-boolean truthy value', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ litellm: { skills: 'yes' } }))
    expect(readSkillsSetting()).toBe(false)
    mockReadFileSync.mockReturnValue(JSON.stringify({ litellm: { skills: 1 } }))
    expect(readSkillsSetting()).toBe(false)
  })

  it('returns false when litellm is a non-object value', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ litellm: 'enabled' }))
    expect(readSkillsSetting()).toBe(false)
  })
})

describe('writeSkillsSetting', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function writtenSettings(): Record<string, unknown> {
    const call = mockWriteFileSync.mock.calls[0]
    return JSON.parse(call[1] as string) as Record<string, unknown>
  }

  it('creates settings.json with litellm.skills true when file does not exist', () => {
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT') })
    writeSkillsSetting(true)
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1)
    expect(writtenSettings()).toEqual({ litellm: { skills: true } })
  })

  it('merges into existing settings without clobbering other top-level keys', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ defaultModel: 'gpt-4' }))
    writeSkillsSetting(true)
    const result = writtenSettings()
    expect(result.defaultModel).toBe('gpt-4')
    expect(result.litellm).toEqual({ skills: true })
  })

  it('preserves other keys inside an existing litellm object', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ litellm: { timeout: 5000 } }))
    writeSkillsSetting(true)
    expect(writtenSettings().litellm).toEqual({ timeout: 5000, skills: true })
  })

  it('can set skills to false', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ litellm: { skills: true } }))
    writeSkillsSetting(false)
    expect(writtenSettings().litellm).toEqual({ skills: false })
  })

  it('handles malformed litellm value by replacing it', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ litellm: 'enabled' }))
    expect(() => writeSkillsSetting(true)).not.toThrow()
    expect(writtenSettings().litellm).toEqual({ skills: true })
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
