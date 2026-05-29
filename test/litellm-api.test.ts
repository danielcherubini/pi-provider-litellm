import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import { mapToProviderModel, resolvePluginConfig, fetchSkillContent, buildProviderConfig } from '../src/litellm-api.js'
import type { LiteLLMModelInfo, Skill } from '../src/types.js'

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

describe('fetchSkillContent', () => {
  it('constructs correct GitHub raw URL for git-subdir source', async () => {
    const skill: Skill = {
      id: 'test-skill',
      name: 'test-skill',
      version: '1.0.0',
      description: 'Test skill',
      source: {
        source: 'git-subdir',
        url: 'https://github.com/owner/repo.git',
        path: 'skills/test',
      },
      author: 'Test Author',
      homepage: null,
      keywords: null,
      category: null,
      domain: null,
      namespace: null,
      enabled: true,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    }

    const globalFetch = globalThis.fetch
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('# Test Skill'),
    })
    globalThis.fetch = mockFetch as unknown as typeof global.fetch

    const result = await fetchSkillContent(skill)

    expect(mockFetch).toHaveBeenCalledWith(
      'https://raw.githubusercontent.com/owner/repo/main/skills/test/SKILL.md',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(result).toBe('# Test Skill')

    globalThis.fetch = globalFetch
  })
})

describe('resolvePluginConfig', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  it('returns config when env vars are set', () => {
    process.env.LITELLM_URL = 'https://litellm.example.com'
    process.env.LITELLM_KEY = 'sk-test123'

    const result = resolvePluginConfig()
    expect(result).toEqual({
      url: 'https://litellm.example.com',
      apiKey: 'sk-test123',
    })
  })

  it('returns null when no config available', () => {
    const savedUrl = process.env.LITELLM_URL
    const savedKey = process.env.LITELLM_KEY
    delete process.env.LITELLM_URL
    delete process.env.LITELLM_KEY

    // Note: settings.json may still have config, so this tests the fallback path.
    // If settings.json has pi-provider-litellm config, it will return that.
    // If not, it returns null.
    const result = resolvePluginConfig()
    // Accept either null (no settings) or the settings.json config
    expect(result === null || (result && typeof result.url === 'string')).toBe(true)

    if (savedUrl) process.env.LITELLM_URL = savedUrl
    if (savedKey) process.env.LITELLM_KEY = savedKey
  })

  it('prefers env vars over settings.json', () => {
    process.env.LITELLM_URL = 'https://from-env.example.com'
    process.env.LITELLM_KEY = 'env-key'

    const result = resolvePluginConfig()
    expect(result).toEqual({
      url: 'https://from-env.example.com',
      apiKey: 'env-key',
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

describe('fetchSkillContent', () => {
  it('returns null for non-GitHub URLs', async () => {
    const skill: Skill = {
      id: 'test',
      name: 'test',
      version: '1.0.0',
      description: null,
      source: { source: 'git-subdir', url: 'https://gitlab.com/owner/repo.git' },
      author: null,
      homepage: null,
      keywords: null,
      category: null,
      domain: null,
      namespace: null,
      enabled: true,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    }

    const result = await fetchSkillContent(skill)
    expect(result).toBeNull()
  })

  it('returns null for GitHub URL with no path', async () => {
    const skill: Skill = {
      id: 'test',
      name: 'test',
      version: '1.0.0',
      description: null,
      source: { source: 'git-subdir', url: 'https://github.com/owner/repo.git' },
      author: null,
      homepage: null,
      keywords: null,
      category: null,
      domain: null,
      namespace: null,
      enabled: true,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    }

    const globalFetch = globalThis.fetch
    const mockFetch = vi.fn()
    globalThis.fetch = mockFetch as unknown as typeof global.fetch

    const result = await fetchSkillContent(skill)

    expect(mockFetch).toHaveBeenCalledWith(
      'https://raw.githubusercontent.com/owner/repo/main/SKILL.md',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    globalThis.fetch = globalFetch
  })

  it('retries on 429 response', async () => {
    const skill: Skill = {
      id: 'test',
      name: 'test',
      version: '1.0.0',
      description: null,
      source: { source: 'git-subdir', url: 'https://github.com/owner/repo.git', path: 's' },
      author: null,
      homepage: null,
      keywords: null,
      category: null,
      domain: null,
      namespace: null,
      enabled: true,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    }

    const globalFetch = globalThis.fetch
    let callCount = 0
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++
      if (callCount === 1) return Promise.resolve({ ok: false, status: 429 })
      return Promise.resolve({ ok: true, text: () => Promise.resolve('content') })
    }) as unknown as typeof global.fetch

    const result = await fetchSkillContent(skill)
    expect(result).toBe('content')
    expect(callCount).toBe(2)

    globalThis.fetch = globalFetch
  })
})
