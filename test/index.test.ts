import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { PluginConfig } from '../src/types.js'
import { AUTH_TOAST_LINE, AUTH_STATUS_LINE } from '../src/auth-state.js'

const mockConfig: PluginConfig = { url: 'http://localhost:4000', apiKey: 'test-key', providerId: 'litellm' }
const mockGetToken = () => Promise.resolve('test-key')

/** Fake Provider object — matches what buildNativeProvider returns */
const fakeProvider = { id: 'litellm' }

function createMockPi(): MockPi {
  const handlers: Record<string, Function[]> = {}
  // eventHandlers maps channel -> list of handler functions registered via events.on
  const eventHandlers: Record<string, Function[]> = {}
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
    events: {
      on: vi.fn((channel: string, handler: Function) => {
        if (!eventHandlers[channel]) eventHandlers[channel] = []
        eventHandlers[channel].push(handler)
        return () => {}
      }),
      emit: vi.fn(),
      eventHandlers,
    },
  }
}

function makeFakeCtx(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  return {
    hasUI: true,
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      theme: { fg: (_c: string, t: string) => t },
    },
    sessionManager: {
      getSessionId: vi.fn().mockReturnValue('test-session-id'),
    },
    ...overrides,
  } as unknown as ExtensionContext
}

interface MockPi {
  on: ReturnType<typeof vi.fn>
  registerProvider: ReturnType<typeof vi.fn>
  unregisterProvider: ReturnType<typeof vi.fn>
  registerTool: ReturnType<typeof vi.fn>
  registerCommand: ReturnType<typeof vi.fn>
  handlers: Record<string, Function[]>
  events: {
    on: ReturnType<typeof vi.fn>
    emit: ReturnType<typeof vi.fn>
    eventHandlers: Record<string, Function[]>
  }
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

describe('bridge: auth event → UI notifications', () => {
  let origFetch: typeof globalThis.fetch

  beforeEach(() => {
    vi.resetModules()
    origFetch = globalThis.fetch
    globalThis.fetch = vi.fn() as unknown as typeof global.fetch
    // Default env: gcloud mode
    vi.stubEnv('LITELLM_GCLOUD_TOKEN_AUTH', '1')
    // Standard mocks for all tests in this block
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
    vi.doMock('../src/litellm-api.js', () => ({
      resolvePluginConfig: () => mockConfig,
      discoverMcpTools: vi.fn().mockResolvedValue([]),
      buildNativeProvider: vi.fn().mockReturnValue(fakeProvider),
      readSkillsSetting: vi.fn().mockReturnValue(false),
      writeSkillsSetting: vi.fn(),
    }))
    vi.doMock('../src/gcloud-token.js', () => ({
      getGcloudToken: vi.fn(() => Promise.resolve('tok')),
      resetTokenCache: vi.fn(),
      getLastTokenFailure: vi.fn(() => null),
    }))
  })

  afterEach(() => {
    globalThis.fetch = origFetch
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('bridge: auth_failed fires notify + status once', async () => {
    const mod = await import('../src/index.js')
    const mockPi = createMockPi()
    await mod.default(mockPi as unknown as ExtensionAPI)

    // Invoke session_start so currentCtx is populated
    const fakeCtx = makeFakeCtx()
    const sessionStartHandler = mockPi.handlers['session_start']?.[0]
    await sessionStartHandler?.({ }, fakeCtx)

    // Fire the auth_failed event handler
    const failedHandlers = mockPi.events.eventHandlers['litellm:auth_failed'] ?? []
    expect(failedHandlers.length).toBeGreaterThan(0)
    await failedHandlers[0]?.({ code: 'invalid_grant', detail: 'HTTP 400: invalid_grant' })

    const ui = fakeCtx.ui as { notify: ReturnType<typeof vi.fn>; setStatus: ReturnType<typeof vi.fn>; setWidget: ReturnType<typeof vi.fn> }
    expect(ui.notify).toHaveBeenCalledTimes(1)
    expect(ui.notify).toHaveBeenCalledWith(
      AUTH_TOAST_LINE,
      'error'
    )
    expect(ui.setStatus).toHaveBeenCalledTimes(1)
    expect(ui.setStatus).toHaveBeenCalledWith(
      'litellm',
      AUTH_STATUS_LINE
    )
    expect(ui.setWidget).toHaveBeenCalledTimes(1)
    expect(ui.setWidget).toHaveBeenCalledWith(
      'litellm',
      [AUTH_STATUS_LINE],
      { placement: 'aboveEditor' }
    )
  })

  it('bridge: auth_recovered clears status + info toast', async () => {
    const mod = await import('../src/index.js')
    const mockPi = createMockPi()
    await mod.default(mockPi as unknown as ExtensionAPI)

    const fakeCtx = makeFakeCtx()
    const sessionStartHandler = mockPi.handlers['session_start']?.[0]
    await sessionStartHandler?.({ }, fakeCtx)

    const recoveredHandlers = mockPi.events.eventHandlers['litellm:auth_recovered'] ?? []
    expect(recoveredHandlers.length).toBeGreaterThan(0)
    await recoveredHandlers[0]?.(undefined)

    const ui = fakeCtx.ui as { notify: ReturnType<typeof vi.fn>; setStatus: ReturnType<typeof vi.fn>; setWidget: ReturnType<typeof vi.fn> }
    expect(ui.setStatus).toHaveBeenCalledTimes(1)
    expect(ui.setStatus).toHaveBeenCalledWith('litellm', undefined)
    expect(ui.setWidget).toHaveBeenCalledTimes(1)
    expect(ui.setWidget).toHaveBeenCalledWith('litellm', undefined)
    expect(ui.notify).toHaveBeenCalledTimes(1)
    expect(ui.notify).toHaveBeenCalledWith('litellm: token recovered', 'info')
  })

  it('bridge: no UI ops when no ctx or hasUI false', async () => {
    const mod = await import('../src/index.js')
    const mockPi = createMockPi()
    await mod.default(mockPi as unknown as ExtensionAPI)

    // (i) Fire BEFORE any session_start — currentCtx is undefined
    const failedHandlers = mockPi.events.eventHandlers['litellm:auth_failed'] ?? []
    await failedHandlers[0]?.({ code: 'invalid_grant', detail: 'HTTP 400: invalid_grant' })
    // No ctx exists → no UI ops, no error

    // (ii) Fire with hasUI: false
    const noUiCtx = makeFakeCtx({ hasUI: false })
    const sessionStartHandler = mockPi.handlers['session_start']?.[0]
    await sessionStartHandler?.({ }, noUiCtx)

    const noUiCtxUi = noUiCtx.ui as { notify: ReturnType<typeof vi.fn>; setStatus: ReturnType<typeof vi.fn> }
    await failedHandlers[0]?.({ code: 'invalid_grant', detail: 'HTTP 400: invalid_grant' })
    expect(noUiCtxUi.notify).not.toHaveBeenCalled()
    expect(noUiCtxUi.setStatus).not.toHaveBeenCalled()
  })

  it('static mode registers no litellm bus handlers', async () => {
    vi.unstubAllEnvs()
    delete process.env.LITELLM_GCLOUD_TOKEN_AUTH

    const mod = await import('../src/index.js')
    const mockPi = createMockPi()
    await mod.default(mockPi as unknown as ExtensionAPI)

    const channels = (mockPi.events.on as ReturnType<typeof vi.fn>).mock.calls.map(
      (call: unknown[]) => call[0] as string
    )
    expect(channels).not.toContain('litellm:auth_failed')
    expect(channels).not.toContain('litellm:auth_recovered')
  })

  it('bridge: session_shutdown clears ctx so stale auth_failed does not call UI', async () => {
    const mod = await import('../src/index.js')
    const mockPi = createMockPi()
    await mod.default(mockPi as unknown as ExtensionAPI)

    // Populate currentCtx via session_start
    const fakeCtx = makeFakeCtx()
    const sessionStartHandler = mockPi.handlers['session_start']?.[0]
    await sessionStartHandler?.({}, fakeCtx)

    // Now invoke session_shutdown with the same ctx → should clear currentCtx
    const sessionShutdownHandler = mockPi.handlers['session_shutdown']?.[0]
    await sessionShutdownHandler?.({}, fakeCtx)

    // Fire auth_failed after shutdown — currentCtx is cleared, so no UI ops
    const failedHandlers = mockPi.events.eventHandlers['litellm:auth_failed'] ?? []
    expect(failedHandlers.length).toBeGreaterThan(0)
    await failedHandlers[0]?.({ code: 'invalid_grant', detail: 'HTTP 400: invalid_grant' })

    const ui = fakeCtx.ui as { notify: ReturnType<typeof vi.fn>; setStatus: ReturnType<typeof vi.fn>; setWidget: ReturnType<typeof vi.fn> }
    expect(ui.notify).not.toHaveBeenCalled()
    expect(ui.setStatus).not.toHaveBeenCalled()
    expect(ui.setWidget).not.toHaveBeenCalled()
  })

  it('bridge: session_start re-fires UI when token is already broken', async () => {
    // Configure gcloud token mock: token is empty → broken state at startup
    const mockGetGcloudToken = vi.fn().mockResolvedValue('')
    const mockGetLastTokenFailure = vi.fn().mockReturnValue({ code: 'invalid_grant', detail: 'HTTP 400: invalid_grant' })
    vi.doMock('../src/gcloud-token.js', () => ({
      getGcloudToken: mockGetGcloudToken,
      resetTokenCache: vi.fn(),
      getLastTokenFailure: mockGetLastTokenFailure,
    }))

    const mod = await import('../src/index.js')
    const mockPi = createMockPi()
    await mod.default(mockPi as unknown as ExtensionAPI)

    // The authTracker.get() is called during startup (syncRemoteSkills → getToken → authTracker.get())
    // which transitions state to 'broken' and emits 'litellm:auth_failed' via pi.events.emit.
    // Since there's no currentCtx yet, no UI ops should have happened.
    // Verify emit was called with auth_failed
    expect(mockPi.events.emit).toHaveBeenCalledWith('litellm:auth_failed', expect.anything())

    // No UI ops yet — no session_start has fired
    // Now invoke session_start with a fresh ctx
    const fakeCtx = makeFakeCtx()
    const sessionStartHandler = mockPi.handlers['session_start']?.[0]
    await sessionStartHandler?.({}, fakeCtx)

    const ui = fakeCtx.ui as {
      notify: ReturnType<typeof vi.fn>
      setStatus: ReturnType<typeof vi.fn>
      setWidget: ReturnType<typeof vi.fn>
    }

    // session_start should re-fire the auth broken UI
    expect(ui.notify).toHaveBeenCalledTimes(1)
    expect(ui.notify).toHaveBeenCalledWith(AUTH_TOAST_LINE, 'error')
    expect(ui.setStatus).toHaveBeenCalledTimes(1)
    expect(ui.setStatus).toHaveBeenCalledWith('litellm', AUTH_STATUS_LINE)
    expect(ui.setWidget).toHaveBeenCalledTimes(1)
    expect(ui.setWidget).toHaveBeenCalledWith(
      'litellm',
      [AUTH_STATUS_LINE],
      { placement: 'aboveEditor' }
    )
  })
})
