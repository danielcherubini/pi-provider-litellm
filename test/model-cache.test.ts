import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { LiteLLMModelInfo } from '../src/types.js'

const mockReadFileSync = vi.hoisted(() => vi.fn())
const mockWriteFileSync = vi.hoisted(() => vi.fn())

vi.mock('node:fs', () => ({
  default: {
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
  },
}))

vi.mock('node:os', () => ({
  default: { homedir: () => '/home/test' },
}))

// Import after mocks are set up
const { loadModelCache, saveModelCache } = await import('../src/model-cache.js')

const sampleModels: Record<string, LiteLLMModelInfo> = {
  'gpt-4': {
    model_name: 'gpt-4',
    max_input_tokens: 8192,
    max_output_tokens: 8192,
    input_cost_per_token: 0.00001,
    output_cost_per_token: 0.00003,
  },
  'claude-sonnet': {
    model_name: 'claude-sonnet',
    max_input_tokens: 200000,
    max_output_tokens: 64000,
  },
}

describe('loadModelCache', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('returns null when cache file does not exist', () => {
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT') })
    const result = loadModelCache('litellm')
    expect(result).toBeNull()
  })

  it('returns null when cache file contains invalid JSON', () => {
    mockReadFileSync.mockReturnValue('not valid json{{{')
    const result = loadModelCache('litellm')
    expect(result).toBeNull()
  })

  it('returns null when providerId does not match', () => {
    const cache = { savedAt: Date.now(), providerId: 'other-provider', models: sampleModels }
    mockReadFileSync.mockReturnValue(JSON.stringify(cache))
    const result = loadModelCache('litellm')
    expect(result).toBeNull()
  })

  it('returns null when models field is missing', () => {
    const cache = { savedAt: Date.now(), providerId: 'litellm', models: null }
    mockReadFileSync.mockReturnValue(JSON.stringify(cache))
    const result = loadModelCache('litellm')
    expect(result).toBeNull()
  })

  it('returns models when cache is valid', () => {
    const cache = { savedAt: Date.now(), providerId: 'litellm', models: sampleModels }
    mockReadFileSync.mockReturnValue(JSON.stringify(cache))
    const result = loadModelCache('litellm')
    expect(result).toEqual(sampleModels)
  })

  it('reads from the correct path', () => {
    const cache = { savedAt: Date.now(), providerId: 'litellm', models: sampleModels }
    mockReadFileSync.mockReturnValue(JSON.stringify(cache))
    loadModelCache('litellm')
    expect(mockReadFileSync).toHaveBeenCalledWith(
      expect.stringContaining('pi-provider-litellm-cache.json'),
      'utf-8',
    )
  })
})

describe('saveModelCache', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('writes a valid cache file', () => {
    saveModelCache('litellm', sampleModels)
    expect(mockWriteFileSync).toHaveBeenCalledOnce()
    const [filePath, content] = mockWriteFileSync.mock.calls[0] as [string, string, string]
    expect(filePath).toContain('pi-provider-litellm-cache.json')
    const parsed = JSON.parse(content)
    expect(parsed.providerId).toBe('litellm')
    expect(parsed.models).toEqual(sampleModels)
    expect(typeof parsed.savedAt).toBe('number')
  })

  it('writes to the correct path', () => {
    saveModelCache('protector', sampleModels)
    const [filePath] = mockWriteFileSync.mock.calls[0] as [string, string, string]
    expect(filePath).toMatch(/\.pi[/\\]agent[/\\]pi-provider-litellm-cache\.json/)
  })

  it('does not throw when writeFileSync fails', () => {
    mockWriteFileSync.mockImplementation(() => { throw new Error('EACCES') })
    expect(() => saveModelCache('litellm', sampleModels)).not.toThrow()
  })

  it('round-trips correctly with loadModelCache', () => {
    let written = ''
    mockWriteFileSync.mockImplementation((_path: string, content: string) => { written = content })
    mockReadFileSync.mockImplementation(() => written)

    saveModelCache('litellm', sampleModels)
    const loaded = loadModelCache('litellm')
    expect(loaded).toEqual(sampleModels)
  })
})
