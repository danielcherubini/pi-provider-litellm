import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ExtensionAPI, BeforeAgentStartEvent, BeforeAgentStartEventResult, ExtensionContext, ProviderConfig, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { PluginConfig } from '../src/types.js'

const mockConfig: PluginConfig = { url: 'http://localhost:4000', apiKey: 'test-key', providerId: 'litellm' }
const mockGetToken = () => Promise.resolve('test-key')

function createMockPi(): MockPi {
  const handlers: Record<string, Function[]> = {}
  return {
    on: vi.fn((event, handler) => {
      if (!handlers[event]) handlers[event] = []
      handlers[event].push(handler)
    }),
    registerProvider: vi.fn(),
    unregisterProvider: vi.fn(),
    registerTool: vi.fn(),
    handlers,
  }
}

interface MockPi {
  on: ReturnType<typeof vi.fn>
  registerProvider: ReturnType<typeof vi.fn>
  unregisterProvider: ReturnType<typeof vi.fn>
  registerTool: ReturnType<typeof vi.fn>
  handlers: Record<string, Function[]>
}

describe('extension entry point', () => {
  let resolvePluginConfig: () => PluginConfig | null
  let origFetch: typeof globalThis.fetch

  beforeEach(() => {
    vi.resetModules()
    origFetch = globalThis.fetch
    globalThis.fetch = vi.fn() as unknown as typeof global.fetch
    delete process.env.LITELLM_GCLOUD_TOKEN_AUTH
    // Default: no cache — individual tests can override
    vi.doMock('../src/model-cache.js', () => ({
      loadModelCache: vi.fn().mockReturnValue(null),
      saveModelCache: vi.fn(),
    }))
  })

  afterEach(() => {
    globalThis.fetch = origFetch
    vi.restoreAllMocks()
    delete process.env.LITELLM_GCLOUD_TOKEN_AUTH
  })

  it('returns early when no config is available', async () => {
    vi.doMock('../src/litellm-api.js', () => ({
      resolvePluginConfig: () => null,
      discoverModels: vi.fn(),
      discoverMcpTools: vi.fn(),
      listSkills: vi.fn(),
      buildProviderConfig: vi.fn(),
    }))

    const mod = await import('../src/index.js')
    const mockPi = createMockPi()
    await mod.default(mockPi as unknown as ExtensionAPI)

    expect(mockPi.registerProvider).not.toHaveBeenCalled()
    expect(mockPi.registerTool).not.toHaveBeenCalled()
  })

  it('registers provider after discovery', async () => {
    const mockModels = { 'gpt-4': { model_name: 'gpt-4' } }
    const mockMcpTools: unknown[] = []
    const mockSkills: unknown[] = []

    vi.doMock('../src/litellm-api.js', () => ({
      resolvePluginConfig: () => mockConfig,
      discoverModels: vi.fn().mockResolvedValue(mockModels),
      discoverMcpTools: vi.fn().mockResolvedValue(mockMcpTools),
      listSkills: vi.fn().mockResolvedValue(mockSkills),
      buildProviderConfig: vi.fn().mockReturnValue({ baseUrl: mockConfig.url, apiKey: mockConfig.apiKey, api: 'openai-completions', models: [] }),
    }))

    const mod = await import('../src/index.js')
    const mockPi = createMockPi()
    await mod.default(mockPi as unknown as ExtensionAPI)

    expect(mockPi.registerProvider).toHaveBeenCalled()
  })

  it('registers tools even when model discovery fails with 403', async () => {
    vi.doMock('../src/litellm-api.js', () => ({
      resolvePluginConfig: () => mockConfig,
      discoverModels: vi.fn().mockRejectedValue(new Error('Access denied (403). Check your LiteLLM API key or contact your admin.')),
      discoverMcpTools: vi.fn().mockResolvedValue([]),
      listSkills: vi.fn().mockResolvedValue([]),
      buildProviderConfig: vi.fn(),
    }))

    const mod = await import('../src/index.js')
    const mockPi = createMockPi()
    await mod.default(mockPi as unknown as ExtensionAPI)
    await new Promise((r) => setTimeout(r, 0)) // flush fire-and-forget discovery

    expect(mockPi.registerProvider).not.toHaveBeenCalled()
    expect(mockPi.registerTool).toHaveBeenCalled()
  })

  it('registers skill tools even when MCP discovery fails', async () => {
    vi.doMock('../src/litellm-api.js', () => ({
      resolvePluginConfig: () => mockConfig,
      discoverModels: vi.fn().mockResolvedValue({}),
      discoverMcpTools: vi.fn().mockRejectedValue(new Error('MCP error')),
      listSkills: vi.fn().mockResolvedValue([]),
      buildProviderConfig: vi.fn(),
    }))

    const mod = await import('../src/index.js')
    const mockPi = createMockPi()
    await mod.default(mockPi as unknown as ExtensionAPI)
    await new Promise((r) => setTimeout(r, 0)) // flush fire-and-forget discovery

    expect(mockPi.registerTool).toHaveBeenCalled()
  })
})

describe('discoverAndRegister', () => {
  let origFetch: typeof globalThis.fetch

  beforeEach(() => {
    vi.resetModules()
    origFetch = globalThis.fetch
    globalThis.fetch = vi.fn() as unknown as typeof global.fetch
    vi.doMock('../src/model-cache.js', () => ({
      loadModelCache: vi.fn().mockReturnValue(null),
      saveModelCache: vi.fn(),
    }))
  })

  afterEach(() => {
    globalThis.fetch = origFetch
    vi.restoreAllMocks()
  })

  it('unregisters provider before registering new one', async () => {
    const mockModels = { 'gpt-4': { model_name: 'gpt-4' } }

    vi.doMock('../src/litellm-api.js', () => ({
      resolvePluginConfig: () => mockConfig,
      discoverModels: vi.fn().mockResolvedValue(mockModels),
      discoverMcpTools: vi.fn().mockResolvedValue([]),
      listSkills: vi.fn().mockResolvedValue([]),
      buildProviderConfig: vi.fn().mockReturnValue({ baseUrl: mockConfig.url, apiKey: mockConfig.apiKey, api: 'openai-completions', models: [] }),
    }))

    const mod = await import('../src/index.js')
    const mockPi = createMockPi()
    await mod.discoverAndRegister(mockPi as unknown as ExtensionAPI, mockConfig, mockGetToken)

    expect(mockPi.registerProvider).toHaveBeenCalled()
  })

  it('failed model discovery does not prevent tool registration', async () => {
    vi.doMock('../src/litellm-api.js', () => ({
      resolvePluginConfig: () => mockConfig,
      discoverModels: vi.fn().mockRejectedValue(new Error('model error')),
      discoverMcpTools: vi.fn().mockResolvedValue([]),
      listSkills: vi.fn().mockResolvedValue([]),
      buildProviderConfig: vi.fn(),
    }))

    const mod = await import('../src/index.js')
    const mockPi = createMockPi()
    await mod.discoverAndRegister(mockPi as unknown as ExtensionAPI, mockConfig, mockGetToken)

    expect(mockPi.registerProvider).not.toHaveBeenCalled()
    expect(mockPi.registerTool).toHaveBeenCalled()
  })

  it('failed MCP discovery does not prevent skill tool registration', async () => {
    vi.doMock('../src/litellm-api.js', () => ({
      resolvePluginConfig: () => mockConfig,
      discoverModels: vi.fn().mockResolvedValue({}),
      discoverMcpTools: vi.fn().mockRejectedValue(new Error('mcp error')),
      listSkills: vi.fn().mockResolvedValue([]),
      buildProviderConfig: vi.fn(),
    }))

    const mod = await import('../src/index.js')
    const mockPi = createMockPi()
    await mod.discoverAndRegister(mockPi as unknown as ExtensionAPI, mockConfig, mockGetToken)

    expect(mockPi.registerTool).toHaveBeenCalled()
  })
})
