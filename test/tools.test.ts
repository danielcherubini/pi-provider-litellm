import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Type } from 'typebox'
import {
  sanitizeName,
  buildTypeBoxSchema,
  createMcpToolDefinitions,
  createSkillToolDefinitions,
  createSkillsInjector,
} from '../src/tools.js'
import type { McpTool, PluginConfig } from '../src/types.js'

const mockConfig: PluginConfig = { url: 'http://localhost:4000', apiKey: 'test-key', providerId: 'litellm' }
const mockGetToken = () => Promise.resolve('test-token')

describe('sanitizeName', () => {
  it('lowercases and replaces non-alphanumeric with underscore', () => {
    expect(sanitizeName('My-Tool_Name 123')).toBe('my_tool_name_123')
    expect(sanitizeName('UPPER.CASE')).toBe('upper_case')
    expect(sanitizeName('hello/world')).toBe('hello_world')
  })

  it('handles already clean names', () => {
    expect(sanitizeName('cleanname')).toBe('cleanname')
  })
})

describe('buildTypeBoxSchema', () => {
  it('maps string type', () => {
    const schema = buildTypeBoxSchema({
      type: 'object',
      properties: { name: { type: 'string' } },
    })
    expect(schema).not.toBeNull()
    expect(schema).toEqual(Type.Object({ name: Type.String() }))
  })

  it('maps string with minLength/maxLength', () => {
    const schema = buildTypeBoxSchema({
      type: 'object',
      properties: { name: { type: 'string', minLength: 1, maxLength: 100 } },
    })
    expect(schema).not.toBeNull()
    expect(schema).toEqual(
      Type.Object({ name: Type.String({ minLength: 1, maxLength: 100 }) }),
    )
  })

  it('maps number type', () => {
    const schema = buildTypeBoxSchema({
      type: 'object',
      properties: { count: { type: 'number' } },
    })
    expect(schema).not.toBeNull()
    expect(schema).toEqual(Type.Object({ count: Type.Number() }))
  })

  it('maps integer type', () => {
    const schema = buildTypeBoxSchema({
      type: 'object',
      properties: { count: { type: 'integer' } },
    })
    expect(schema).not.toBeNull()
    expect(schema).toEqual(Type.Object({ count: Type.Number() }))
  })

  it('maps number with minimum/maximum', () => {
    const schema = buildTypeBoxSchema({
      type: 'object',
      properties: { count: { type: 'number', minimum: 0, maximum: 100 } },
    })
    expect(schema).not.toBeNull()
    expect(schema).toEqual(
      Type.Object({ count: Type.Number({ minimum: 0, maximum: 100 }) }),
    )
  })

  it('maps boolean type', () => {
    const schema = buildTypeBoxSchema({
      type: 'object',
      properties: { enabled: { type: 'boolean' } },
    })
    expect(schema).not.toBeNull()
     expect(schema).toEqual(Type.Object({ enabled: Type.Boolean() }))
  })

  it('maps array of strings', () => {
    const schema = buildTypeBoxSchema({
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' } } },
    })
    expect(schema).not.toBeNull()
     expect(schema).toEqual(Type.Object({ tags: Type.Array(Type.String()) }))
  })

  it('maps array of numbers', () => {
    const schema = buildTypeBoxSchema({
      type: 'object',
      properties: { values: { type: 'array', items: { type: 'number' } } },
    })
    expect(schema).not.toBeNull()
     expect(schema).toEqual(Type.Object({ values: Type.Array(Type.Number()) }))
  })

  it('maps enum to union of literals', () => {
    const schema = buildTypeBoxSchema({
      type: 'object',
      properties: { status: { type: 'string', enum: ['active', 'inactive'] } },
    })
    expect(schema).not.toBeNull()
    expect(schema).toEqual(
      Type.Object(
        { status: Type.Union([Type.Literal('active'), Type.Literal('inactive')]) },
        {},
      ),
    )
  })

  it('returns null for nested object property', () => {
    const schema = buildTypeBoxSchema({
      type: 'object',
      properties: { nested: { type: 'object', properties: {} } },
    })
    expect(schema).toBeNull()
  })

  it('returns null for $ref property', () => {
    const schema = buildTypeBoxSchema({
      type: 'object',
      properties: { ref: { $ref: '#/definitions/Thing' } },
    })
    expect(schema).toBeNull()
  })

  it('returns null for $ref at top level', () => {
    const schema = buildTypeBoxSchema({
      $ref: '#/definitions/Thing',
      properties: { name: { type: 'string' } },
    })
    expect(schema).toBeNull()
  })

  it('returns null for anyOf', () => {
    const schema = buildTypeBoxSchema({
      type: 'object',
      properties: { val: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
    })
    expect(schema).toBeNull()
  })

  it('returns null for oneOf', () => {
    const schema = buildTypeBoxSchema({
      type: 'object',
      properties: { val: { oneOf: [{ type: 'string' }, { type: 'number' }] } },
    })
    expect(schema).toBeNull()
  })

  it('returns null for allOf', () => {
    const schema = buildTypeBoxSchema({
      type: 'object',
      properties: { val: { allOf: [{ type: 'string' }] } },
    })
    expect(schema).toBeNull()
  })

  it('sets required array when required fields present', () => {
    const schema = buildTypeBoxSchema({
      type: 'object',
      properties: { name: { type: 'string' }, age: { type: 'number' } },
      required: ['name'],
    })
    expect(schema).not.toBeNull()
    expect(schema).toEqual(
      Type.Object(
        { name: Type.String(), age: Type.Number() },
        { required: ['name'] },
      ),
    )
  })
})

describe('createMcpToolDefinitions', () => {
  const mockMcpTools: McpTool[] = [
    {
      name: 'read_file',
      server_name: 'File-Server',
      description: 'Read a file from disk',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
    {
      name: 'search_web',
      server_name: 'Search-API',
      description: 'Search the web',
      input_schema: {
        type: 'object',
        properties: { query: { type: 'string' } },
      },
    },
  ]

  it('produces correct mcp_{server}_{tool} names', () => {
    const defs = createMcpToolDefinitions(mockConfig, mockGetToken, mockMcpTools)
    expect(defs[0].name).toBe('mcp_file_server_read_file')
    expect(defs[1].name).toBe('mcp_search_api_search_web')
  })

  it('includes server name in description', () => {
    const defs = createMcpToolDefinitions(mockConfig, mockGetToken, mockMcpTools)
    expect(defs[0].description).toContain('via File-Server MCP server')
    expect(defs[1].description).toContain('via Search-API MCP server')
  })

  it('label matches name', () => {
    const defs = createMcpToolDefinitions(mockConfig, mockGetToken, mockMcpTools)
    expect(defs[0].label).toBe(defs[0].name)
    expect(defs[1].label).toBe(defs[1].name)
  })

  it('uses fallback args schema for unparseable input_schema', () => {
    const defs = createMcpToolDefinitions(mockConfig, mockGetToken, [
      {
        name: 'broken',
        server_name: 'test',
        description: 'Broken tool',
        input_schema: { not_a_real_schema: true },
      },
    ])
    expect(defs[0].parameters).toEqual(Type.Object({ args: Type.String() }))
  })
})

describe('createSkillToolDefinitions', () => {
  it('returns 5 tools', () => {
    const defs = createSkillToolDefinitions(mockConfig, mockGetToken)
    expect(defs).toHaveLength(5)
  })

  it('has correct tool names', () => {
    const defs = createSkillToolDefinitions(mockConfig, mockGetToken)
    const names = defs.map((d) => d.name)
    expect(names).toContain('skill_list')
    expect(names).toContain('skill_use')
    expect(names).toContain('skill_register')
    expect(names).toContain('skill_enable')
    expect(names).toContain('skill_disable')
  })

  it('skill_list has no parameters', () => {
    const defs = createSkillToolDefinitions(mockConfig, mockGetToken)
    const listTool = defs.find((d) => d.name === 'skill_list')
    expect(listTool).toBeDefined()
    expect(listTool!.parameters).toEqual(Type.Object({}))
  })

  it('skill_use has name parameter', () => {
    const defs = createSkillToolDefinitions(mockConfig, mockGetToken)
    const useTool = defs.find((d) => d.name === 'skill_use')
    expect(useTool).toBeDefined()
    expect(useTool!.parameters).toEqual(Type.Object({ name: Type.String() }))
  })

  it('skill_register has name, git_url, git_path, description, domain parameters', () => {
    const defs = createSkillToolDefinitions(mockConfig, mockGetToken)
    const regTool = defs.find((d) => d.name === 'skill_register')
    expect(regTool).toBeDefined()
    expect(regTool!.parameters).toEqual(
      Type.Object({
        name: Type.String(),
        git_url: Type.String(),
        git_path: Type.String(),
        description: Type.String(),
        domain: Type.Optional(Type.String()),
      }),
    )
  })
})

describe('createSkillsInjector', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof global.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('returns null when no enabled skills', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ plugins: [] }),
    })

    const injector = createSkillsInjector(mockConfig, mockGetToken)
    const result = await injector.getSkillsSummary()
    expect(result).toBeNull()
  })

  it('returns XML summary for enabled skills', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          plugins: [
            {
              id: 'skill-1',
              name: 'test-skill',
              version: '1.0.0',
              description: 'A test skill',
              source: { source: 'git-subdir', url: 'https://github.com/o/r.git', path: 's' },
              author: null,
              homepage: null,
              keywords: null,
              category: null,
              domain: null,
              namespace: null,
              enabled: true,
              created_at: '2024-01-01T00:00:00Z',
              updated_at: '2024-01-01T00:00:00Z',
            },
          ],
        }),
    })

    const injector = createSkillsInjector(mockConfig, mockGetToken)
    const result = await injector.getSkillsSummary()
    expect(result).toContain('<available-skills>')
    expect(result).toContain('test-skill')
    expect(result).toContain('</available-skills>')
  })

  it('caches results within TTL', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ plugins: [] }),
    })

    const injector = createSkillsInjector(mockConfig, mockGetToken)
    await injector.getSkillsSummary()
    await injector.getSkillsSummary()
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('clearCache resets the cache', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ plugins: [] }),
    })

    const injector = createSkillsInjector(mockConfig, mockGetToken)
    await injector.getSkillsSummary()
    injector.clearCache()
    await injector.getSkillsSummary()
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
  })
})
