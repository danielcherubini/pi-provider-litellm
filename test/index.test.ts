import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { PluginConfig } from '../src/types.js'

const mockConfig: PluginConfig = { url: 'http://localhost:4000', apiKey: 'test-key', providerId: 'litellm' }
const mockGetToken = () => Promise.resolve('test-key')

/** Fake Provider object — matches what buildNativeProvider returns */
const fakeProvider = { id: 'litellm' }

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
    registerCommand: vi.fn(),
    handlers,
  }
}

interface MockPi {
  on: ReturnType<typeof vi.fn>
  registerProvider: ReturnType<typeof vi.fn>
  unregisterProvider: ReturnType<typeof vi.fn>
  registerTool: ReturnType<typeof vi.fn>
  registerCommand: ReturnType<typeof vi.fn>
  handlers: Record<string, Function[]>
}

describe('extension entry point', () => {
  let origFetch: typeof globalThis.fetch

  beforeEach(() => {
    vi.resetModules()
    origFetch = globalThis.fetch
    globalThis.fetch = vi.fn() as unknown as typeof global.fetch
    delete process.env.LITELLM_GCLOUD_TOKEN_AUTH
    vi.doMock('../src/skills-cache.js', () => ({
      syncRemoteSkills: vi.fn().mockResolvedValue({ count: 0, names: [], errored: [] }),
      clearSkillsCache: vi.fn(),
      getCachedSkillNames: vi.fn().mockReturnValue([]),
      getCacheAgeMinutes: vi.fn().mockReturnValue(null),
    }))
    vi.doMock('@earendil-works/pi-ai', () => ({
      createAssistantMessageEventStream: vi.fn(),
    }))
    vi.doMock('@earendil-works/pi-ai/compat', () => ({
      streamSimpleOpenAICompletions: vi.fn(),
      openAICompletionsApi: vi.fn().mockReturnValue({ stream: vi.fn(), streamSimple: vi.fn() }),
    }))
  })

  afterEach(() => {
    globalThis.fetch = origFetch
    vi.restoreAllMocks()
  })

  it('returns early when no config is available', async () => {
    vi.doMock('../src/litellm-api.js', () => ({
      resolvePluginConfig: () => null,
      discoverMcpTools: vi.fn(),
      buildNativeProvider: vi.fn().mockReturnValue(fakeProvider),
      readSkillsSetting: vi.fn().mockReturnValue(false),
    }))

    const mod = await import('../src/index.js')
    const mockPi = createMockPi()
    await mod.default(mockPi as unknown as ExtensionAPI)

    expect(mockPi.registerProvider).not.toHaveBeenCalled()
    expect(mockPi.registerTool).not.toHaveBeenCalled()
  })

  it('registers provider once at startup via buildNativeProvider', async () => {
    vi.doMock('../src/litellm-api.js', () => ({
      resolvePluginConfig: () => mockConfig,
      discoverMcpTools: vi.fn().mockResolvedValue([]),
      buildNativeProvider: vi.fn().mockReturnValue(fakeProvider),
      readSkillsSetting: vi.fn().mockReturnValue(false),
      writeSkillsSetting: vi.fn(),
    }))

    const mod = await import('../src/index.js')
    const mockPi = createMockPi()
    await mod.default(mockPi as unknown as ExtensionAPI)

    // Exactly 1 registration — the native Provider from buildNativeProvider
    expect(mockPi.registerProvider).toHaveBeenCalledTimes(1)
    expect(mockPi.registerProvider).toHaveBeenCalledWith(fakeProvider)
  })

  it('registers tools even when MCP discovery fails', async () => {
    vi.doMock('../src/litellm-api.js', () => ({
      resolvePluginConfig: () => mockConfig,
      discoverMcpTools: vi.fn().mockRejectedValue(new Error('MCP error')),
      buildNativeProvider: vi.fn().mockReturnValue(fakeProvider),
      readSkillsSetting: vi.fn().mockReturnValue(false),
      writeSkillsSetting: vi.fn(),
    }))

    const mod = await import('../src/index.js')
    const mockPi = createMockPi()
    await mod.default(mockPi as unknown as ExtensionAPI)

    // Provider still registered despite MCP failure
    expect(mockPi.registerProvider).toHaveBeenCalledWith(fakeProvider)
  })

  it('registers skill tools when skills are enabled even if MCP discovery fails', async () => {
    vi.doMock('../src/litellm-api.js', () => ({
      resolvePluginConfig: () => mockConfig,
      discoverMcpTools: vi.fn().mockRejectedValue(new Error('MCP error')),
      buildNativeProvider: vi.fn().mockReturnValue(fakeProvider),
      readSkillsSetting: vi.fn().mockReturnValue(true),
      writeSkillsSetting: vi.fn(),
    }))

    const mod = await import('../src/index.js')
    const mockPi = createMockPi()
    await mod.default(mockPi as unknown as ExtensionAPI)

    expect(mockPi.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: 'skill_list' }))
  })

  it('does not register skill tools when skills are disabled', async () => {
    vi.doMock('../src/litellm-api.js', () => ({
      resolvePluginConfig: () => mockConfig,
      discoverMcpTools: vi.fn().mockResolvedValue([]),
      buildNativeProvider: vi.fn().mockReturnValue(fakeProvider),
      readSkillsSetting: vi.fn().mockReturnValue(false),
      writeSkillsSetting: vi.fn(),
    }))

    const mod = await import('../src/index.js')
    const mockPi = createMockPi()
    await mod.default(mockPi as unknown as ExtensionAPI)

    expect(mockPi.registerTool).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'skill_list' }))
  })

  it('does not sync remote skills when skills are disabled', async () => {
    const syncMock = vi.fn().mockResolvedValue({ count: 0, names: [], errored: [] })
    vi.doMock('../src/skills-cache.js', () => ({
      syncRemoteSkills: syncMock,
      clearSkillsCache: vi.fn(),
      getCachedSkillNames: vi.fn().mockReturnValue([]),
      getCacheAgeMinutes: vi.fn().mockReturnValue(null),
    }))
    vi.doMock('../src/litellm-api.js', () => ({
      resolvePluginConfig: () => mockConfig,
      discoverMcpTools: vi.fn().mockResolvedValue([]),
      buildNativeProvider: vi.fn().mockReturnValue(fakeProvider),
      readSkillsSetting: vi.fn().mockReturnValue(false),
      writeSkillsSetting: vi.fn(),
    }))

    const mod = await import('../src/index.js')
    const mockPi = createMockPi()
    await mod.default(mockPi as unknown as ExtensionAPI)

    expect(syncMock).not.toHaveBeenCalled()
  })

  it('syncs remote skills when skills are enabled', async () => {
    const syncMock = vi.fn().mockResolvedValue({ count: 0, names: [], errored: [] })
    vi.doMock('../src/skills-cache.js', () => ({
      syncRemoteSkills: syncMock,
      clearSkillsCache: vi.fn(),
      getCachedSkillNames: vi.fn().mockReturnValue([]),
      getCacheAgeMinutes: vi.fn().mockReturnValue(null),
    }))
    vi.doMock('../src/litellm-api.js', () => ({
      resolvePluginConfig: () => mockConfig,
      discoverMcpTools: vi.fn().mockResolvedValue([]),
      buildNativeProvider: vi.fn().mockReturnValue(fakeProvider),
      readSkillsSetting: vi.fn().mockReturnValue(true),
      writeSkillsSetting: vi.fn(),
    }))

    const mod = await import('../src/index.js')
    const mockPi = createMockPi()
    await mod.default(mockPi as unknown as ExtensionAPI)

    expect(syncMock).toHaveBeenCalled()
  })
})

describe('discoverAndRegisterTools', () => {
  let origFetch: typeof globalThis.fetch

  beforeEach(() => {
    vi.resetModules()
    origFetch = globalThis.fetch
    globalThis.fetch = vi.fn() as unknown as typeof global.fetch
    vi.doMock('../src/skills-cache.js', () => ({
      syncRemoteSkills: vi.fn().mockResolvedValue({ count: 0, names: [], errored: [] }),
      clearSkillsCache: vi.fn(),
      getCachedSkillNames: vi.fn().mockReturnValue([]),
      getCacheAgeMinutes: vi.fn().mockReturnValue(null),
    }))
    vi.doMock('@earendil-works/pi-ai', () => ({
      createAssistantMessageEventStream: vi.fn(),
    }))
    vi.doMock('@earendil-works/pi-ai/compat', () => ({
      streamSimpleOpenAICompletions: vi.fn(),
      openAICompletionsApi: vi.fn().mockReturnValue({ stream: vi.fn(), streamSimple: vi.fn() }),
    }))
  })

  afterEach(() => {
    globalThis.fetch = origFetch
    vi.restoreAllMocks()
  })

  it('registers MCP tools when discovery succeeds', async () => {
    vi.doMock('../src/litellm-api.js', () => ({
      resolvePluginConfig: () => mockConfig,
      discoverMcpTools: vi.fn().mockResolvedValue([{ name: 'mcp_tool', description: 'x', input_schema: { type: 'object' }, server_name: 'srv' }]),
      buildNativeProvider: vi.fn().mockReturnValue(fakeProvider),
      readSkillsSetting: vi.fn().mockReturnValue(false),
      writeSkillsSetting: vi.fn(),
    }))

    const mod = await import('../src/index.js')
    const mockPi = createMockPi()
    await mod.discoverAndRegisterTools(mockPi as unknown as ExtensionAPI, mockConfig, mockGetToken)

    expect(mockPi.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: 'mcp_srv_mcp_tool' }))
  })

  it('registers skill tools when skillsEnabled is true', async () => {
    vi.doMock('../src/litellm-api.js', () => ({
      resolvePluginConfig: () => mockConfig,
      discoverMcpTools: vi.fn().mockRejectedValue(new Error('mcp error')),
      buildNativeProvider: vi.fn().mockReturnValue(fakeProvider),
      readSkillsSetting: vi.fn().mockReturnValue(false),
      writeSkillsSetting: vi.fn(),
    }))

    const mod = await import('../src/index.js')
    const mockPi = createMockPi()
    await mod.discoverAndRegisterTools(mockPi as unknown as ExtensionAPI, mockConfig, mockGetToken, undefined, true)

    expect(mockPi.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: 'skill_list' }))
  })

  it('does not register skill tools when skillsEnabled is omitted (defaults false)', async () => {
    vi.doMock('../src/litellm-api.js', () => ({
      resolvePluginConfig: () => mockConfig,
      discoverMcpTools: vi.fn().mockResolvedValue([]),
      buildNativeProvider: vi.fn().mockReturnValue(fakeProvider),
      readSkillsSetting: vi.fn().mockReturnValue(false),
      writeSkillsSetting: vi.fn(),
    }))

    const mod = await import('../src/index.js')
    const mockPi = createMockPi()
    await mod.discoverAndRegisterTools(mockPi as unknown as ExtensionAPI, mockConfig, mockGetToken)

    expect(mockPi.registerTool).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'skill_list' }))
  })

  it('registers MCP tools even when skillsEnabled is false', async () => {
    vi.doMock('../src/litellm-api.js', () => ({
      resolvePluginConfig: () => mockConfig,
      discoverMcpTools: vi.fn().mockResolvedValue([{ name: 'mcp_tool', description: 'x', input_schema: { type: 'object' }, server_name: 'srv' }]),
      buildNativeProvider: vi.fn().mockReturnValue(fakeProvider),
      readSkillsSetting: vi.fn().mockReturnValue(false),
      writeSkillsSetting: vi.fn(),
    }))

    const mod = await import('../src/index.js')
    const mockPi = createMockPi()
    await mod.discoverAndRegisterTools(mockPi as unknown as ExtensionAPI, mockConfig, mockGetToken, undefined, false)

    expect(mockPi.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: 'mcp_srv_mcp_tool' }))
    expect(mockPi.registerTool).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'skill_list' }))
  })

  it('does not call registerProvider — models are managed by createProvider fetchModels', async () => {
    vi.doMock('../src/litellm-api.js', () => ({
      resolvePluginConfig: () => mockConfig,
      discoverMcpTools: vi.fn().mockResolvedValue([]),
      buildNativeProvider: vi.fn().mockReturnValue(fakeProvider),
      readSkillsSetting: vi.fn().mockReturnValue(false),
      writeSkillsSetting: vi.fn(),
    }))

    const mod = await import('../src/index.js')
    const mockPi = createMockPi()
    await mod.discoverAndRegisterTools(mockPi as unknown as ExtensionAPI, mockConfig, mockGetToken)

    expect(mockPi.registerProvider).not.toHaveBeenCalled()
  })
})
