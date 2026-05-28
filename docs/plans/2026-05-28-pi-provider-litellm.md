# pi-provider-litellm Plan

**Goal:** Build a pi agent extension that auto-discovers models, MCP tools, and skills from a LiteLLM proxy.
**Architecture:** Follows the `pi-provider-tama` extension pattern — async entry point, `pi.registerProvider()` for models, `pi.registerTool()` for MCP and skill tools, parallel discovery on `session_start`.
**Tech Stack:** TypeScript, Node.js stdlib + `fetch`, `@earendil-works/pi-coding-agent` peer dependency.

---

### Task 1: Scaffolding, types, and API client

**Context:**
This task establishes the package foundation: `package.json`, `tsconfig.json`, `vitest.config.ts`, and the two core modules that handle types and HTTP communication with the LiteLLM proxy. The API client is the only code that talks to the network, so it needs robust error handling, timeouts, and graceful failure.

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `src/types.ts`
- Create: `src/litellm-api.ts`
- Create: `test/litellm-api.test.ts`

**What to implement:**

**`package.json`:**
```json
{
  "name": "pi-provider-litellm",
  "version": "0.1.0",
  "description": "Pi agent extension for LiteLLM proxy auto-discovery and model configuration",
  "type": "module",
  "main": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "files": ["src"],
  "pi": {
    "extensions": ["./src/index.ts"]
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest",
    "test:run": "vitest run"
  },
  "keywords": ["pi-package", "pi", "pi-agent", "litellm", "extension", "auto-discovery"],
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "typebox": "*"
  },
  "devDependencies": {
    "typescript": "^5.9.0",
    "vitest": "^4.0.0",
    "@types/node": "^22.0.0",
    "@earendil-works/pi-coding-agent": "*"
  },
  "author": "Daniel Cherubini",
  "license": "MIT"
}
```

**`tsconfig.json`:**
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "outDir": "dist"
  },
  "include": ["src"]
}
```

**`vitest.config.ts`:**
```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
})
```
Tests must use explicit imports: `import { describe, it, expect, vi, beforeEach } from 'vitest'`. Do NOT use globals.

**`.gitignore`:**
```
node_modules/
dist/
*.tsbuildinfo
```

**`src/types.ts`:**
Define all LiteLLM response types and re-export pi types from `@earendil-works/pi-coding-agent`:
```ts
import type { ProviderModelConfig, ProviderConfig } from '@earendil-works/pi-coding-agent'

export type { ProviderModelConfig, ProviderConfig }

// LiteLLM /health endpoint response
export interface LiteLLMHealthModel {
  model: string
  model_id: string
}

export interface LiteLLMHealthResponse {
  healthy_endpoints?: LiteLLMHealthModel[]
}

// LiteLLM /model/info response
export interface LiteLLMModelInfo {
  model_name?: string
  max_tokens?: number
  max_input_tokens?: number
  max_output_tokens?: number
  supports_function_calling?: boolean
  supports_reasoning?: boolean
  supports_vision?: boolean
  supports_audio_input?: boolean
  supports_pdf_input?: boolean
  input_cost_per_token?: number
  output_cost_per_token?: number
  cache_read_input_token_cost?: number
  cache_creation_input_token_cost?: number
}

// MCP tool from /mcp-rest/tools/list
export interface McpTool {
  name: string
  server_name: string
  description: string
  input_schema: Record<string, unknown>
}

// Skill types from /claude-code/plugins
export interface SkillSource {
  source: string
  url: string
  path?: string
}

export interface Skill {
  id: string
  name: string
  version: string
  description: string | null
  source: SkillSource
  author: string | null
  homepage: string | null
  keywords: string | null
  category: string | null
  domain: string | null
  namespace: string | null
  enabled: boolean
  created_at: string
  updated_at: string
}

export interface SkillPluginsResponse {
  plugins?: Skill[]
}

// Plugin config resolved from env or settings
export interface PluginConfig {
  url: string
  apiKey: string
}
```

**`src/litellm-api.ts`:**
HTTP client for all LiteLLM proxy endpoints. Every function takes `(config: PluginConfig, token: string)` and returns empty results on failure. Use `AbortController` with 10s timeout for discovery, 30s for tool execution.

Functions to implement:
- `discoverModels(config, token): Promise<Record<string, LiteLLMModelInfo>>` — calls `GET /health`, then `GET /model/info?litellm_model_id=<uuid>` for each healthy endpoint in parallel. Returns map of `model_name → model_info`.
- `discoverMcpTools(config, token): Promise<McpTool[]>` — calls `GET /mcp-rest/tools/list`. Returns `[]` on any error.
- `executeMcpTool(config, token, server, toolName, args): Promise<string>` — calls `POST /mcp-rest/tools/call`. Returns JSON string or error message.
- `listSkills(config, token): Promise<Skill[]>` — calls `GET /claude-code/plugins`. Returns `[]` on any error.
- `registerSkill(config, token, name, gitUrl, gitPath, description?, domain?): Promise<string>` — calls `POST /claude-code/plugins`. Returns success/error string.
- `enableSkill(config, token, name): Promise<string>` — calls `POST /claude-code/plugins/<name>/enable`.
- `disableSkill(config, token, name): Promise<string>` — calls `POST /claude-code/plugins/<name>/disable`.
- `fetchSkillContent(skill: Skill): Promise<string | null>` — builds GitHub raw URL, fetches SKILL.md. 5s timeout, 2 retries on 429/5xx. Returns `null` on failure.
- `resolvePluginConfig(): PluginConfig | null` — checks `LITELLM_URL`/`LITELLM_KEY` env vars first, then `~/.pi/agent/settings.json` → `pi-provider-litellm.url`/`.token`. Returns `null` if neither source provides both url and apiKey.
- `mapToProviderModel(info: LiteLLMModelInfo): ProviderModelConfig` — maps LiteLLM model info to pi's `ProviderModelConfig`. Cost is in $/million tokens (LiteLLM uses $/token, so multiply by 1,000,000). Input modalities: `['text']` + `'image'` if `supports_vision`. Compat: `{ supportsDeveloperRole: false, supportsReasoningEffort: false }`.
- `buildProviderConfig(url: string, apiKey: string, models: Record<string, LiteLLMModelInfo>): ProviderConfig` — builds `ProviderConfig` with `baseUrl: url`, `apiKey`, `api: 'openai-completions'`, and mapped models.

**`test/litellm-api.test.ts`:**
- Test `mapToProviderModel` with vision model → input includes `'image'`
- Test `mapToProviderModel` with reasoning model → `reasoning: true`
- Test `mapToProviderModel` with costs → multiplied by 1,000,000
- Test `fetchSkillContent` GitHub URL construction for git-subdir source
- Test `resolvePluginConfig` with env vars set
- Test `resolvePluginConfig` returns null when no config available

**Steps:**
- [ ] Create `package.json`, `tsconfig.json`, `vitest.config.ts`
- [ ] Create `src/types.ts` with all interfaces
- [ ] Create `src/litellm-api.ts` with all functions
- [ ] Create `test/litellm-api.test.ts` with tests for mapping and config resolution
- [ ] Run `npm install` to install dev deps (typescript, vitest, @types/node, @earendil-works/pi-coding-agent)
- [ ] Run `npx tsc --noEmit` — must succeed
- [ ] Run `npx vitest run` — all tests must pass
- [ ] Commit with message: "feat: scaffolding, types, and LiteLLM API client"

**Acceptance criteria:**
- [ ] `tsc --noEmit` passes with no errors
- [ ] All tests pass
- [ ] `mapToProviderModel` correctly maps vision, reasoning, costs, and compat
- [ ] `resolvePluginConfig` checks env vars before settings.json
- [ ] All API functions return empty results on network errors

---

### Task 2: Tool definitions (MCP + Skills)

**Context:**
This task builds the `AgentTool` definitions that the extension registers with pi. MCP tools are discovered dynamically from the proxy and mapped to TypeBox schemas. Skill tools are static CRUD operations. The skills injector caches skill listings and injects a summary on first turn.

**Files:**
- Create: `src/tools.ts`
- Create: `test/tools.test.ts`

**What to implement:**

**`src/tools.ts`:**
Import `Type` from `typebox` directly (peer dependency, NOT from `@earendil-works/pi-coding-agent`). Import `ToolDefinition`, `AgentToolResult`, `AgentToolUpdateCallback`, `ExtensionContext`, `TSchema` from `@earendil-works/pi-coding-agent`.

- `sanitizeName(name: string): string` — lowercase, replace non-alphanumeric with `_`
- `buildTypeBoxSchema(inputSchema: Record<string, unknown>): TSchema | null` — converts JSON Schema to TypeBox. Supports:
  - `string` → `Type.String()` (with `minLength`/`maxLength` if present)
  - `number`/`integer` → `Type.Number()` (with `minimum`/`maximum` if present)
  - `boolean` → `Type.Boolean()`
  - `array` of `string` → `Type.Array(Type.String())`
  - `array` of `number` → `Type.Array(Type.Number())`
  - `enum`/`const` → `Type.Union([...])` or `Type.Literal(value)`
  - Rejects: nested objects, `$ref`, `anyOf`, `oneOf`, `allOf` → return `null`
  - Returns `Type.Object({ ... })` with `required` array for required fields, or `null` if any property can't be mapped
- `createMcpToolDefinitions(config, token, mcpTools: McpTool[]): ToolDefinition[]` — for each MCP tool, creates a `ToolDefinition` with:
  - `name: \`mcp_${sanitizeName(server)}_${sanitizeName(tool)}\``
  - `description: \`${desc} (via ${server} MCP server)\``
  - `parameters`: result of `buildTypeBoxSchema`, or `Type.Object({ args: Type.String() })` as fallback (single string arg that the agent JSON-serializes, simpler than `Type.Record` which has typebox compatibility issues)
  - `label`: same as name
  - `execute(toolCallId, params, signal, onUpdate, ctx)`: calls `executeMcpTool(config, token, server, toolName, params)`, returns `{ content: [{ type: 'text', text: result }], details: { server, tool: toolName } }`. The `onUpdate` and `ctx` parameters must be accepted per `ToolDefinition` signature but can be unused (MCP tools don't stream partial updates or need context).
- `createSkillToolDefinitions(config, token): ToolDefinition[]` — returns 5 tools:
  - `skill_list`: no params, calls `listSkills`, returns markdown table
  - `skill_use`: `{ name: Type.String() }`, calls `listSkills` + `fetchSkillContent`, returns `<skill>` XML block
  - `skill_register`: `{ name, git_url, git_path: Type.String(), description, domain: Type.Optional(Type.String()) }`, calls `registerSkill`
  - `skill_enable`: `{ name: Type.String() }`, calls `enableSkill`
  - `skill_disable`: `{ name: Type.String() }`, calls `disableSkill`
- `createSkillsInjector(config, token)` — returns object with:
  - `getSkillsSummary(): Promise<string | null>` — fetches skills (60s TTL cache), returns `<available-skills>\n...\n</available-skills>` if enabled skills exist, or `null` if none
  - `clearCache(): void` — resets the cache

**`test/tools.test.ts`:**
- Test `sanitizeName` with special characters
- Test `buildTypeBoxSchema` with string, number, boolean, array, enum
- Test `buildTypeBoxSchema` returns null for nested object
- Test `buildTypeBoxSchema` returns null for `$ref`
- Test `createMcpToolDefinitions` produces correct `mcp_{server}_{tool}` names
- Test `createSkillToolDefinitions` returns 5 tools

**Steps:**
- [ ] Create `src/tools.ts` with all functions
- [ ] Create `test/tools.test.ts` with schema mapping and tool name tests
- [ ] Run `npx tsc --noEmit` — must succeed
- [ ] Run `npx vitest run` — all tests must pass
- [ ] Commit with message: "feat: MCP and skill tool definitions with TypeBox schema mapping"

**Acceptance criteria:**
- [ ] `tsc --noEmit` passes
- [ ] All tests pass
- [ ] MCP tool names use `mcp_{server}_{tool}` prefix (no collision with `skill_*`)
- [ ] `buildTypeBoxSchema` supports string, number, boolean, array[string], array[number], enum
- [ ] `buildTypeBoxSchema` returns null for nested objects, $ref, anyOf/oneOf/allOf
- [ ] Skill tools return 5 ToolDefinitions
- [ ] Skills injector caches with 60s TTL

---

### Task 3: Extension entry point and integration

**Context:**
This task wires everything together in `index.ts`. The async extension entry point resolves config, discovers models/tools/skills in parallel, and registers them with pi. It hooks `session_start` for re-discovery and `session_shutdown` for cleanup.

**Files:**
- Create: `src/index.ts`
- Create: `test/index.test.ts`

**What to implement:**

**`src/index.ts`:**
```ts
import type { ExtensionAPI, BeforeAgentStartEvent, BeforeAgentStartEventResult } from '@earendil-works/pi-coding-agent'
import { resolvePluginConfig, discoverModels, discoverMcpTools, listSkills, buildProviderConfig } from './litellm-api.js'
import { createMcpToolDefinitions, createSkillToolDefinitions, createSkillsInjector } from './tools.js'

const PROVIDER_NAME = 'litellm'

export default async function (pi: ExtensionAPI): Promise<void> {
  const config = resolvePluginConfig()
  if (!config) {
    console.log('[pi-provider-litellm] No LiteLLM config found. Set LITELLM_URL/LITELLM_KEY or ~/.pi/agent/settings.json')
    return
  }

  // Initial discovery
  await discoverAndRegister(pi, config)

  // Skills injection via before_agent_start — appends available skills to system prompt
  const injector = createSkillsInjector(config, config.apiKey)
  const setupCompleteSessions = new Set<string>()
  pi.on('before_agent_start', async (event: BeforeAgentStartEvent, ctx): Promise<BeforeAgentStartEventResult> => {
    // Only inject once per session start (not every turn)
    const sessionId = ctx.sessionManager.getSessionInfo()?.sessionFile
    if (sessionId && setupCompleteSessions.has(sessionId)) return {}
    if (sessionId) setupCompleteSessions.add(sessionId)

    const summary = await injector.getSkillsSummary()
    if (!summary) return {}
    return { systemPrompt: event.systemPrompt + '\n\n' + summary }
  })

  // Re-discover on session start
  pi.on('session_start', async (event, ctx) => {
    // Clear per-session tracking so skills re-inject on new sessions
    setupCompleteSessions.clear()
    injector.clearCache()
    await discoverAndRegister(pi, config)
  })

  // Clear skills cache on session shutdown
  pi.on('session_shutdown', async (event, ctx) => {
    injector.clearCache()
  })
}

async function discoverAndRegister(pi: ExtensionAPI, config: PluginConfig): Promise<void> {
  // Unregister old provider to remove stale models
  pi.unregisterProvider(PROVIDER_NAME)

  // Run all discovery in parallel with Promise.allSettled, wrapped in 30s outer timeout
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 30_000)

  try {
    const [modelsResult, mcpResult, skillsResult] = await Promise.race([
      Promise.allSettled([
        discoverModels(config, config.apiKey),
        discoverMcpTools(config, config.apiKey),
        listSkills(config, config.apiKey),
      ]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Discovery timeout')), 30_000)),
    ])

  // Register models
  if (modelsResult.status === 'fulfilled' && Object.keys(modelsResult.value).length > 0) {
    const providerConfig = buildProviderConfig(config.url, config.apiKey, modelsResult.value)
    pi.registerProvider(PROVIDER_NAME, providerConfig)
    console.log(`[pi-provider-litellm] Registered ${Object.keys(modelsResult.value).length} models`)
  } else if (modelsResult.status === 'rejected') {
    console.warn(`[pi-provider-litellm] Model discovery failed: ${modelsResult.reason}`)
  }

  // Register MCP tools
  if (mcpResult.status === 'fulfilled') {
    const mcpTools = createMcpToolDefinitions(config, config.apiKey, mcpResult.value)
    for (const tool of mcpTools) {
      pi.registerTool(tool)
    }
    if (mcpTools.length > 0) {
      console.log(`[pi-provider-litellm] Registered ${mcpTools.length} MCP tools`)
    }
  } else {
    console.warn(`[pi-provider-litellm] MCP tool discovery failed: ${mcpResult.reason}`)
  }

  // Register skill tools
  const skillTools = createSkillToolDefinitions(config, config.apiKey)
  for (const tool of skillTools) {
    pi.registerTool(tool)
  }
  } catch (error) {
    console.warn(`[pi-provider-litellm] Discovery failed: ${error}`)
  } finally {
    clearTimeout(timeoutId)
  }
}
```

Key details:
- `Promise.allSettled` ensures one failure doesn't block the others
- `pi.unregisterProvider(PROVIDER_NAME)` before re-registering to remove stale models
- `pi.registerTool()` for each MCP and skill tool
- Config resolved once at load time (env vars/settings don't change at runtime)
- All console output is prefixed with `[pi-provider-litellm]`
- 403 errors from `discoverModels` are logged with descriptive message

**`test/index.test.ts`:**
- Test that extension returns early when no config is available
- Test that `discoverAndRegister` calls `unregisterProvider` before `registerProvider`
- Test that failed model discovery doesn't prevent tool registration
- Test that MCP tool discovery failure doesn't prevent skill tool registration

**Steps:**
- [ ] Create `src/index.ts` with async extension entry point
- [ ] Create `test/index.test.ts` with integration tests
- [ ] Run `npx tsc --noEmit` — must succeed
- [ ] Run `npx vitest run` — all tests must pass
- [ ] Commit with message: "feat: extension entry point with parallel discovery and tool registration"

**Acceptance criteria:**
- [ ] `tsc --noEmit` passes
- [ ] All tests pass
- [ ] Extension returns early when no config available
- [ ] Discovery runs in parallel via `Promise.allSettled`
- [ ] Failed model discovery doesn't block tool registration
- [ ] `unregisterProvider` is called before `registerProvider` on re-discovery
- [ ] All console output prefixed with `[pi-provider-litellm]`

---

### Task 4: Tests, README, and final polish

**Context:**
Final task to add a README, ensure full test coverage, and verify the package builds correctly.

**Files:**
- Create: `README.md`
- Modify: `test/litellm-api.test.ts` (add more coverage if needed)
- Modify: `test/tools.test.ts` (add more coverage if needed)

**What to implement:**

**`README.md`:**
Brief README covering:
- What the extension does
- Installation: `npm install pi-provider-litellm` (or pi's extension install mechanism)
- Configuration: `LITELLM_URL`/`LITELLM_KEY` env vars or `~/.pi/agent/settings.json`
- Features: model discovery, MCP tools, skills CRUD
- No runtime dependencies

**Steps:**
- [ ] Create `README.md`
- [ ] Run `npx tsc --noEmit` — must succeed
- [ ] Run `npx vitest run` — all tests must pass
- [ ] Verify `package.json` exports and `pi.extensions` field are correct
- [ ] Commit with message: "chore: README and final polish"

**Acceptance criteria:**
- [ ] `tsc --noEmit` passes
- [ ] All tests pass
- [ ] README covers installation, configuration, and features
- [ ] `package.json` has correct `pi.extensions` field pointing to `./src/index.ts`
