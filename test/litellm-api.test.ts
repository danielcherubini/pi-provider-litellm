import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mapToProviderModel, resolvePluginConfig, fetchSkillContent } from '../src/litellm-api.js'
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
    delete process.env.LITELLM_URL
    delete process.env.LITELLM_KEY

    const result = resolvePluginConfig()
    expect(result).toBeNull()
  })
})
