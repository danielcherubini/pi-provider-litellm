import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Type } from 'typebox'
import {
  sanitizeName,
  buildTypeBoxSchema,
  createMcpToolDefinitions,
  createSkillToolDefinitions,
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
  it('returns 1 tool (skill_list)', () => {
    const defs = createSkillToolDefinitions()
    expect(defs).toHaveLength(1)
  })

  it('has skill_list tool', () => {
    const defs = createSkillToolDefinitions()
    expect(defs[0].name).toBe('skill_list')
  })

  it('skill_list has no parameters', () => {
    const defs = createSkillToolDefinitions()
    expect(defs[0].parameters).toEqual(Type.Object({}))
  })
})
