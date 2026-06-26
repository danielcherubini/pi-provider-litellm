import { Type, type TSchema } from 'typebox'
import type {
  ToolDefinition,
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import type { McpTool, PluginConfig } from './types.js'
import { executeMcpTool } from './litellm-api.js'
import { getCachedSkillNames } from './skills-cache.js'

export function sanitizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '_')
}

function mapProperty(type: string, schema: Record<string, unknown>): TSchema | null {
  if (schema.$ref != null) return null
  if (schema.anyOf != null) return null
  if (schema.oneOf != null) return null
  if (schema.allOf != null) return null

  // enum → Type.Union of literals
  if (Array.isArray(schema.enum)) {
    const valid = schema.enum.every((v) => typeof v === 'string' || typeof v === 'number')
    if (!valid) return null
    return Type.Union(schema.enum.map((v) => Type.Literal(v as string | number)))
  }

  // const → Type.Literal
  if ('const' in schema && schema.const != null) {
    const v = schema.const
    if (typeof v !== 'string' && typeof v !== 'number') return null
    return Type.Literal(v)
  }

  switch (type) {
    case 'string': {
      const opts: Record<string, unknown> = {}
      if (typeof schema.minLength === 'number') opts.minLength = schema.minLength
      if (typeof schema.maxLength === 'number') opts.maxLength = schema.maxLength
      return Object.keys(opts).length ? Type.String(opts) : Type.String()
    }
    case 'number':
    case 'integer': {
      const opts: Record<string, unknown> = {}
      if (typeof schema.minimum === 'number') opts.minimum = schema.minimum
      if (typeof schema.maximum === 'number') opts.maximum = schema.maximum
      return Object.keys(opts).length ? Type.Number(opts) : Type.Number()
    }
    case 'boolean':
      return Type.Boolean()
    case 'array': {
      const items = schema.items as Record<string, unknown> | undefined
      if (!items || typeof items !== 'object') return null
      const itemType = items.type as string | undefined
      if (itemType === 'string') return Type.Array(Type.String())
      if (itemType === 'number' || itemType === 'integer') return Type.Array(Type.Number())
      return null
    }
    default:
      return null
  }
}

export function buildTypeBoxSchema(inputSchema: Record<string, unknown>): TSchema | null {
  const properties = inputSchema.properties as Record<string, unknown> | undefined
  if (!properties || typeof properties !== 'object') return null

  // Check for unsupported patterns at top level
  if (inputSchema.$ref != null) return null
  if (inputSchema.anyOf != null) return null
  if (inputSchema.oneOf != null) return null
  if (inputSchema.allOf != null) return null

  const schemaProps: Record<string, TSchema> = {}
  const required: string[] = []
  const requiredList = inputSchema.required as string[] | undefined

  for (const [key, val] of Object.entries(properties)) {
    const prop = val as Record<string, unknown>
    const propType = prop.type as string | undefined
    if (!propType) return null

    // Reject nested objects
    if (propType === 'object') return null

    // Check for nested $ref, anyOf, etc.
    if (prop.$ref != null) return null
    if (prop.anyOf != null) return null
    if (prop.oneOf != null) return null
    if (prop.allOf != null) return null

    const mapped = mapProperty(propType, prop)
    if (mapped === null) return null

    schemaProps[key] = mapped
    if (Array.isArray(requiredList) && requiredList.includes(key)) {
      required.push(key)
    }
  }

  if (required.length) {
    return Type.Object(schemaProps, { required })
  }

  return Type.Object(schemaProps)
}

export function createMcpToolDefinitions(
  config: PluginConfig,
  getToken: () => Promise<string>,
  mcpTools: McpTool[],
): ToolDefinition[] {
  return mcpTools.map((tool) => {
    const server = tool.server_name
    const toolName = tool.name
    const sanitizedName = `mcp_${sanitizeName(server)}_${sanitizeName(toolName)}`
    const description = `${tool.description} (via ${server} MCP server)`
    const parameters = buildTypeBoxSchema(tool.input_schema) ?? Type.Object({ args: Type.String() })

    return {
      name: sanitizedName,
      label: sanitizedName,
      description,
      parameters,
      async execute(
        toolCallId: string,
        params: Record<string, unknown>,
        _signal: AbortSignal | undefined,
        _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
        _ctx: ExtensionContext,
      ): Promise<AgentToolResult<{ server: string; tool: string }>> {
        // If using fallback args schema, parse it
        const args = typeof params === 'object' && params !== null && 'args' in params
          ? (typeof params.args === 'string' ? (() => { try { return JSON.parse(params.args) } catch { return params.args } })() : params.args)
          : params

        const token = await getToken()
        const result = await executeMcpTool(config, token, server, toolName, args as Record<string, unknown>)
        return {
          content: [{ type: 'text', text: result }],
          details: { server, tool: toolName },
        }
      },
    }
  })
}

/**
 * Skill tools for the remote skill cache.
 *
 * Skills are synced to ~/.pi/agent/skills/remote/ on startup, so pi discovers
 * them natively (they appear in <available_skills> and the agent can read them
 * directly). This tool just lists what's available.
 */
export function createSkillToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'skill_list',
      label: 'skill_list',
      description: 'List all available skills (from remote cache)',
      parameters: Type.Object({}),
      async execute(
        _toolCallId: string,
        _params: Record<string, unknown>,
        _signal: AbortSignal | undefined,
        _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
        _ctx: ExtensionContext,
      ): Promise<AgentToolResult<undefined>> {
        const names = getCachedSkillNames()
        if (!names.length) {
          return { content: [{ type: 'text', text: 'No remote skills cached. They will be synced on next session start.' }], details: undefined }
        }
        const header = '| Name | Local Path |'
        const sep = '|------|------------|'
        const rows = names.map((name) => `| ${name} | ~/.pi/agent/skills/remote/${name}/SKILL.md |`)
        return {
          content: [{ type: 'text', text: [header, sep, ...rows].join('\n') }],
          details: undefined,
        }
      },
    },
  ]
}


