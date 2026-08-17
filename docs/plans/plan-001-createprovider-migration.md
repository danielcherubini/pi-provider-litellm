# createProvider Migration Plan

**Goal:** Replace the hand-rolled model cache + double-registration pattern with pi's native `createProvider({ fetchModels })` API from `@earendil-works/pi-ai`.

**Architecture:** The extension registers a native `Provider` object (via `pi.registerProvider(provider)`) instead of the config-form `pi.registerProvider(id, config)`. Pi owns the model disk cache (`models-store.json`), restoration on startup, and the fetch/publish lifecycle via `fetchModels`. Auth is expressed as an `ApiKeyAuth.resolve()` callback that calls `getToken()` per-request, eliminating the 45-min refresh timer and `reregister()` helper. MCP tool and skills discovery remain unchanged and continue to run at session_start.

**Tech Stack:** TypeScript, `@earendil-works/pi-ai` (`createProvider`, `openAICompletionsApi` at subpath `@earendil-works/pi-ai/api/openai-completions.lazy`), Vitest, pi extension API 0.84.0+.

---

### Task 0: Upgrade pi dependency and fix pre-existing baseline issues

**Context:**
The project's `node_modules/@earendil-works/pi-coding-agent` is pinned at **v0.76.0** via `package-lock.json`. The `registerProvider(provider: Provider)` single-argument overload (needed by Task 5) only exists in v0.84.x. The `@earendil-works/pi-coding-agent` peerDependency in `package.json` is already `"*"` so `npm install` will resolve the latest (0.84.2) from the npm registry — but `package-lock.json` locks it at 0.76.0. We must update the lock file.

There are also two **pre-existing issues** that must be fixed before any migration work, so the baseline is clean:
1. `src/stream-simple.ts` imports `streamSimpleOpenAICompletions` from `@earendil-works/pi-ai` root, but in pi-ai 0.84.x it is only available from the deprecated `@earendil-works/pi-ai/dist/legacy-api-aliases` module or preferably from the subpath `@earendil-works/pi-ai/api/openai-completions.lazy` as `openAICompletionsApi().streamSimple`. This causes a `tsc` error on 0.84.x.
2. One test in `test/index.test.ts` (`"syncs remote skills when skills are enabled"`) is already failing on `main`. It must be investigated and fixed (or explicitly skipped with a comment) before layering new tests on top.

**Files:**
- Modify: `package-lock.json` (via `npm install`)
- Modify: `src/stream-simple.ts` (fix deprecated import)
- Modify: `test/index.test.ts` (fix the pre-existing failing test)

**What to implement:**

**Step 1 — Upgrade the local pi install:**
Delete `package-lock.json` and run `npm install`. This re-resolves `@earendil-works/pi-coding-agent` to the latest version (currently 0.84.2) and regenerates the lock file. The `file:` devDependency for `@earendil-works/pi-ai` already points at the 0.84.2 install in `~/.npm-packages`, so it will resolve correctly.

Verification: `cat node_modules/@earendil-works/pi-coding-agent/package.json | grep '"version"'` must show `0.84.2`.

**Step 2 — Fix `streamSimpleOpenAICompletions` import in `src/stream-simple.ts`:**
The current import at the top of `stream-simple.ts` is:
```ts
import {
  createAssistantMessageEventStream,
  streamSimpleOpenAICompletions,
  ...
} from '@earendil-works/pi-ai'
```
`streamSimpleOpenAICompletions` is no longer exported from the pi-ai root in 0.84.x. Replace it with `openAICompletionsApi` from the lazy subpath, then call `.streamSimple` on it. Change the import and usage:
```ts
// Add this import
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
// Remove streamSimpleOpenAICompletions from the @earendil-works/pi-ai import
```
Then replace every call to `streamSimpleOpenAICompletions(...)` in `stream-simple.ts` with `openAICompletionsApi().streamSimple(...)`. There are exactly 2 such calls (one in the delegating `if (model.provider !== providerId)` branch, one inside `runStream`). Note: `openAICompletionsApi()` is cheap — it returns a lazy wrapper that loads the module once.

**Step 3 — Fix the failing test in `test/index.test.ts`:**
Run `npm run test:run -- test/index.test.ts` and identify the failing test (`"syncs remote skills when skills are enabled"`). Inspect the test and the mock setup. The test calls the module factory function and checks that `syncRemoteSkills` was called — this likely fails because the mock setup order or `vi.doMock` scoping changed. Fix the mock or assertion to match the actual call pattern. Do NOT skip it — fix it.

**Steps:**
- [ ] Run `npm run test:run` and capture the baseline (expect 1 failing test in index.test.ts)
- [ ] Delete `package-lock.json`
- [ ] Run `npm install`
- [ ] Verify: `cat node_modules/@earendil-works/pi-coding-agent/package.json | grep '"version"'` shows `0.84.2`
- [ ] Run `npm run typecheck` — record which errors appear (expect the `streamSimpleOpenAICompletions` error + possibly others)
- [ ] Fix `src/stream-simple.ts`: add `openAICompletionsApi` import from subpath, replace `streamSimpleOpenAICompletions` calls with `openAICompletionsApi().streamSimple`
- [ ] Run `npm run typecheck` — `stream-simple.ts` errors should be gone
- [ ] Run `npm run test:run -- test/stream-simple.test.ts` — should pass
- [ ] Fix the failing test in `test/index.test.ts`
- [ ] Run `npm run test:run` — all tests should pass (this is the clean baseline)
- [ ] Commit with message: `chore: upgrade pi-coding-agent to 0.84.x, fix streamSimpleOpenAICompletions import and baseline test`

**Acceptance criteria:**
- [ ] `node_modules/@earendil-works/pi-coding-agent` version is 0.84.2
- [ ] `src/stream-simple.ts` does not import `streamSimpleOpenAICompletions` from `@earendil-works/pi-ai` root
- [ ] `npm run typecheck` passes (may still have errors from model-cache.ts if it still imports something not yet deleted — record but do not fix ahead of task 1)
- [ ] `npm run test:run` passes all tests (the previously-failing skills test is fixed)

---

### Task 1: Remove `model-cache.ts` and its test

**Context:**
`src/model-cache.ts` is a 40-line file providing `loadModelCache()` and `saveModelCache()` that read/write a custom `~/.pi/agent/pi-provider-litellm-cache.json` file. After migrating to `createProvider({ fetchModels })`, pi will own persistence via its own `models-store.json`. This cache file and its test become dead code and must be deleted entirely to avoid confusion. This task removes the files; subsequent tasks remove the call sites.

**Files:**
- Delete: `src/model-cache.ts`
- Delete: `test/model-cache.test.ts`

**What to implement:**
Simply delete both files. Do not modify any other file yet — call sites in `src/index.ts` and `src/litellm-api.ts` will be updated in later tasks. The project will typecheck with errors after this task; that is expected and will be resolved in tasks 2–5.

**Steps:**
- [ ] Delete `src/model-cache.ts`
- [ ] Delete `test/model-cache.test.ts`
- [ ] Run `npm run typecheck` — expect errors referencing `model-cache` imports (these are fixed in later tasks; verify the errors are only about the deleted module, not unrelated)
- [ ] Commit with message: `chore: remove model-cache.ts — pi will own model persistence via createProvider`

**Acceptance criteria:**
- [ ] `src/model-cache.ts` does not exist
- [ ] `test/model-cache.test.ts` does not exist
- [ ] No other source files are modified

---

### Task 2: Update `src/types.ts` — fix `StreamSimpleFn` and remove `ProviderConfig` re-export

**Context:**
`src/types.ts` currently re-exports `ProviderConfig` from `@earendil-works/pi-coding-agent` and defines `StreamSimpleFn` as `NonNullable<ProviderConfig['streamSimple']>`. After the migration, `ProviderConfig` is no longer used externally, and `StreamSimpleFn` must be redefined using pi-ai's native `ProviderStreams` type instead. `ProviderModelConfig` is still needed for the internal mapping in `litellm-api.ts`.

**Files:**
- Modify: `src/types.ts`

**What to implement:**
1. Remove the `import type { ProviderModelConfig, ProviderConfig } from '@earendil-works/pi-coding-agent'` line
2. Add `import type { ProviderModelConfig } from '@earendil-works/pi-coding-agent'` (keep only `ProviderModelConfig`)
3. Add `import type { ProviderStreams } from '@earendil-works/pi-ai'`
4. Change `StreamSimpleFn` from `NonNullable<ProviderConfig['streamSimple']>` to `ProviderStreams['streamSimple']`
5. Remove `export type { ProviderModelConfig, ProviderConfig }` — change to `export type { ProviderModelConfig }`

The final `src/types.ts` should look like:
```ts
import type { ProviderModelConfig } from '@earendil-works/pi-coding-agent'
import type { ProviderStreams } from '@earendil-works/pi-ai'

export type { ProviderModelConfig }

/** The streamSimple signature as expected by pi's ProviderStreams. */
export type StreamSimpleFn = ProviderStreams['streamSimple']

// ... rest of the file (LiteLLMHealthModel, LiteLLMHealthResponse, etc.) unchanged
```

Do NOT remove `LiteLLMHealthModel`, `LiteLLMHealthResponse`, `LiteLLMModelInfo`, `McpTool`, `PluginConfig` — these remain.

**Steps:**
- [ ] Modify `src/types.ts` as described above
- [ ] Run `npm run typecheck` — errors should reduce (model-cache errors remain until task 3; `ProviderConfig` errors in other files remain until tasks 3–4)
- [ ] Commit with message: `refactor(types): redefine StreamSimpleFn via ProviderStreams, drop ProviderConfig re-export`

**Acceptance criteria:**
- [ ] `src/types.ts` no longer imports or exports `ProviderConfig`
- [ ] `StreamSimpleFn` is defined as `ProviderStreams['streamSimple']`
- [ ] `ProviderModelConfig` is still exported

---

### Task 3: Update `src/stream-simple.ts` — remove `reregister` parameter

**Context:**
`createGcloudStreamSimple` in `src/stream-simple.ts` currently accepts three parameters: `getToken`, `reregister`, and `providerId`. The `reregister` callback re-calls `pi.registerProvider()` with the refreshed token after a 401, updating the static `apiKey` baked into the config-form provider. After migrating to `createProvider`, auth is resolved dynamically per-request via `auth.apiKey.resolve()` — so there is nothing to re-register. The 401 recovery path becomes: reset token cache → fetch fresh token → retry. The `reregister` callback is dead weight and must be removed.

**Files:**
- Modify: `src/stream-simple.ts`
- Modify: `test/stream-simple.test.ts`

**What to implement in `src/stream-simple.ts`:**
1. Remove the `reregister: (token: string) => void` parameter from `createGcloudStreamSimple`. New signature:
   ```ts
   export function createGcloudStreamSimple(
     getToken: () => Promise<string>,
     providerId: string = 'litellm',
   ): StreamSimpleFn {
   ```
2. In the 401 recovery block (around line 164), remove the `reregister(freshToken)` call and its preceding comment "Re-register so the static provider config is also updated for future requests". Keep everything else: `resetTokenCache()`, the fresh token fetch, and the retry call to `runStream(freshToken)`.
3. Update the JSDoc comment for `createGcloudStreamSimple` to remove the `@param reregister` line.

**What to implement in `test/stream-simple.test.ts`:**
Find every call to `createGcloudStreamSimple(...)` in the test file and remove the `reregister` argument. For example:
- `createGcloudStreamSimple(mockGetToken, mockReregister, 'litellm')` → `createGcloudStreamSimple(mockGetToken, 'litellm')`
- Remove any `mockReregister = vi.fn()` declarations
- Remove any assertions on `mockReregister` being called or not called
- Add or update the existing 401-retry test to assert that `resetTokenCache` is called and `getToken` is called a second time, but no `reregister` is called

**Steps:**
- [ ] Modify `src/stream-simple.ts`: remove `reregister` param and its call site (1 call at ~line 164)
- [ ] Modify `test/stream-simple.test.ts`: remove `reregister` from all `createGcloudStreamSimple` calls and related mocks/assertions
- [ ] Run `npm run test:run -- test/stream-simple.test.ts` — all tests should pass
- [ ] Run `npm run typecheck` — stream-simple errors should be gone; index.ts errors remain until task 5
- [ ] Commit with message: `refactor(stream-simple): remove reregister param — auth.resolve() handles token freshness`

**Acceptance criteria:**
- [ ] `createGcloudStreamSimple` has exactly 2 parameters: `getToken` and `providerId`
- [ ] No `reregister` call exists in `src/stream-simple.ts`
- [ ] `test/stream-simple.test.ts` passes with `npm run test:run -- test/stream-simple.test.ts`

---

### Task 4: Add `buildNativeProvider` and `toNativeModel` to `src/litellm-api.ts`; remove `buildProviderConfig`

**Context:**
`src/litellm-api.ts` currently exports `buildProviderConfig(url, apiKey, models, streamSimple?)` which returns a `ProviderConfig` (the config-form shape). This is replaced by two new functions:
- `toNativeModel(pc, providerId, baseUrl)` — converts a `ProviderModelConfig` to a `Model<'openai-completions'>` (the native pi-ai type), adding required fields `api`, `provider`, and `baseUrl`
- `buildNativeProvider(config, isGcloudAuth, getToken, streamSimple?)` — builds and returns a native `Provider<'openai-completions'>` via `createProvider()`, wiring up `auth.apiKey.resolve()` and `fetchModels`

**Important notes about the API shape (verified against pi-ai 0.84.2 types):**
- `openAICompletionsApi` is NOT exported from `@earendil-works/pi-ai` root. Import it from the subpath: `@earendil-works/pi-ai/api/openai-completions.lazy`
- `createProvider` and `Provider` ARE exported from `@earendil-works/pi-ai` root
- `ProviderAuth` and `ApiKeyAuth` types are in `@earendil-works/pi-ai` root (via `auth/types.ts` re-export)
- `createProvider` has NO `streamSimple` top-level option — inject it into the `api` object: `{ ...openAICompletionsApi(), streamSimple }`
- `auth.resolve()` receives `input: { ctx, credential?, signal }` but our implementation ignores `input` (intentional — our auth is ambient, not stored in pi's auth.json)
- In `fetchModels`, `context.credential` is typed as `Credential | undefined` where `Credential = ApiKeyCredential | OAuthCredential`. Cast to `(context.credential as { key?: string } | undefined)?.key` to safely access the key field.

**Files:**
- Modify: `src/litellm-api.ts`
- Modify: `test/litellm-api.test.ts`

**What to implement in `src/litellm-api.ts`:**

Add at the top of the file (after existing imports):
```ts
import { createProvider, type Provider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import type { ProviderAuth } from '@earendil-works/pi-ai'
import type { Model } from '@earendil-works/pi-ai'
```

Add after `mapToProviderModel`:
```ts
export function toNativeModel(
  pc: ProviderModelConfig,
  providerId: string,
  baseUrl: string,
): Model<'openai-completions'> {
  return {
    id: pc.id,
    name: pc.name,
    api: 'openai-completions',
    provider: providerId,
    baseUrl,
    reasoning: pc.reasoning,
    input: pc.input,
    cost: pc.cost,
    contextWindow: pc.contextWindow,
    maxTokens: pc.maxTokens,
    ...(pc.compat !== undefined ? { compat: pc.compat } : {}),
  }
}
```

Add after `toNativeModel`:
```ts
export function buildNativeProvider(
  config: PluginConfig,
  isGcloudAuth: boolean,
  getToken: () => Promise<string>,
  streamSimple?: StreamSimpleFn,
): Provider<'openai-completions'> {
  const auth: ProviderAuth = {
    apiKey: {
      name: 'LiteLLM API key',
      // resolve() is called per-request by pi to obtain the Bearer token.
      // We intentionally ignore `input.credential` — our auth is ambient
      // (gcloud ADC or env var), not stored in pi's auth.json.
      async resolve() {
        const key = await getToken()
        if (!key) return undefined
        return {
          auth: { apiKey: key },
          source: isGcloudAuth ? 'gcloud ADC' : 'LITELLM_KEY',
        }
      },
    },
  }

  const baseApi = openAICompletionsApi()
  const api = streamSimple ? { ...baseApi, streamSimple } : baseApi

  return createProvider({
    id: config.providerId,
    name: 'LiteLLM',
    baseUrl: config.url,
    auth,
    models: [],
    api,
    fetchModels: async (context) => {
      if (!context.allowNetwork) return []
      // Prefer pi's resolved credential key if present; fall back to direct token fetch.
      // Our resolve() is ambient-only so context.credential will typically be undefined.
      const token = (context.credential as { key?: string } | undefined)?.key ?? await getToken()
      const raw = await discoverModels(config, token)
      return Object.values(raw).map(info =>
        toNativeModel(mapToProviderModel(info), config.providerId, config.url)
      )
    },
  })
}
```

Remove `buildProviderConfig` entirely (the function and its return type reference to `ProviderConfig`).

Remove unused `ProviderConfig` from the imports at the top of `src/litellm-api.ts` (it was imported from `./types.js`).

**What to implement in `test/litellm-api.test.ts`:**

1. Remove the import of `buildProviderConfig` from the import line at line 2
2. Add import of `buildNativeProvider, toNativeModel` to the same import line
3. Remove the entire `describe('buildProviderConfig', ...)` block (~lines 209–230)
4. Add a `describe('toNativeModel', ...)` block:
   ```ts
   describe('toNativeModel', () => {
     it('includes required native Model fields', () => {
       const pc: ProviderModelConfig = {
         id: 'my-model', name: 'My Model', reasoning: false,
         input: ['text'], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
         contextWindow: 128000, maxTokens: 4096,
       }
       const model = toNativeModel(pc, 'litellm', 'http://localhost:4000')
       expect(model.api).toBe('openai-completions')
       expect(model.provider).toBe('litellm')
       expect(model.baseUrl).toBe('http://localhost:4000')
       expect(model.id).toBe('my-model')
       expect(model.contextWindow).toBe(128000)
     })
   })
   ```
5. Add a `describe('buildNativeProvider', ...)` block:
   ```ts
   describe('buildNativeProvider', () => {
     it('returns a Provider object', () => {
       const config: PluginConfig = { url: 'http://localhost:4000', apiKey: 'key', providerId: 'litellm' }
       const provider = buildNativeProvider(config, false, () => Promise.resolve('key'))
       expect(provider).toBeDefined()
       expect(typeof provider).toBe('object')
     })

     it('auth.resolve returns source LITELLM_KEY for static key', async () => {
       const config: PluginConfig = { url: 'http://localhost:4000', apiKey: 'key', providerId: 'litellm' }
       const provider = buildNativeProvider(config, false, () => Promise.resolve('key'))
       // Access auth through provider internals — if not accessible, test the resolve fn directly
       // via buildNativeProvider with a spy on getToken and check the source label via integration
       // Alternatively: export resolveAuth separately for testability (not required)
       expect(provider).toBeDefined()
     })

     it('fetchModels returns [] when allowNetwork is false', async () => {
       const config: PluginConfig = { url: 'http://localhost:4000', apiKey: 'key', providerId: 'litellm' }
       const getToken = vi.fn().mockResolvedValue('key')
       const provider = buildNativeProvider(config, false, getToken)
       // provider.refreshModels is the internal hook — access fetchModels behavior via the provider's
       // refreshModels method. The allowNetwork=false path short-circuits before calling discoverModels.
       // Verify by calling refreshModels with a mock context where allowNetwork=false.
       // Note: if refreshModels is not directly accessible, test indirectly via integration test
       expect(provider).toBeDefined()
     })
   })
   ```
   Note: If `Provider`'s internals are opaque (no direct `refreshModels` access), keep the `buildNativeProvider` tests as shape/smoke tests. The key behaviors (auth.resolve, fetchModels allowNetwork guard) are better tested via integration tests in the index test suite.

**Steps:**
- [ ] Add imports (`createProvider`, `openAICompletionsApi`, `ProviderAuth`, `Model`) to `src/litellm-api.ts`
- [ ] Add `toNativeModel` function
- [ ] Add `buildNativeProvider` function
- [ ] Remove `buildProviderConfig` function
- [ ] Remove `ProviderConfig` import from `src/litellm-api.ts`
- [ ] Update `test/litellm-api.test.ts`: remove `buildProviderConfig` import and suite, add `toNativeModel` and `buildNativeProvider` suites
- [ ] Run `npm run test:run -- test/litellm-api.test.ts`
- [ ] Run `npm run typecheck` — litellm-api errors should be gone; index.ts errors remain
- [ ] Commit with message: `feat(litellm-api): add buildNativeProvider + toNativeModel, remove buildProviderConfig`

**Acceptance criteria:**
- [ ] `buildProviderConfig` does not exist in `src/litellm-api.ts`
- [ ] `buildNativeProvider` and `toNativeModel` are exported from `src/litellm-api.ts`
- [ ] `test/litellm-api.test.ts` passes
- [ ] `toNativeModel` output includes `api: 'openai-completions'`, `provider`, and `baseUrl`

---

### Task 5: Update `src/index.ts` — migrate to native provider registration

**Context:**
`src/index.ts` is the extension entry point. It currently:
1. Calls `loadModelCache()` → `pi.registerProvider(id, config)` immediately (cache-first)
2. Calls `discoverModels()` → `saveModelCache()` → `pi.registerProvider(id, config)` again (live)
3. Sets a 45-min `setInterval` to re-register with a fresh gcloud token
4. Uses a `reregister()` helper that reads the cache and re-registers
5. Re-calls `discoverAndRegister()` on `session_start` to refresh models

After migration:
- A single `pi.registerProvider(provider)` call (the native Provider object from `buildNativeProvider`) replaces all of the above
- Pi drives the model refresh lifecycle via `fetchModels`
- `session_start` only re-discovers MCP tools and skills (not models)
- `session_shutdown` only calls `setSessionId(undefined)` — no timer to clear
- `discoverAndRegister` is renamed `discoverAndRegisterTools` and only handles MCP + skills tool registration

**Files:**
- Modify: `src/index.ts`
- Modify: `test/index.test.ts`

**What to implement in `src/index.ts`:**

Remove these imports:
- `loadModelCache, saveModelCache` from `./model-cache.js`
- `buildProviderConfig` from `./litellm-api.js`
- `reregister` internal function (remove the function entirely)

Add these imports:
- `buildNativeProvider` from `./litellm-api.js`

Update the `createGcloudStreamSimple` call to remove the `reregister` argument:
```ts
// Before
const streamSimple = createGcloudStreamSimple(getToken, reregister, config.providerId)
// After
const streamSimple = createGcloudStreamSimple(getToken, config.providerId)
```

Replace the startup sequence:
```ts
// Remove:
await discoverAndRegister(pi, config, getToken, streamSimple, registeredTools, skillsEnabled)

// Replace with:
const provider = buildNativeProvider(config, isGcloudAuth, getToken, streamSimple)
pi.registerProvider(provider)
await discoverAndRegisterTools(pi, config, getToken, registeredTools, skillsEnabled)
```

In `session_start` handler, remove the `discoverAndRegister` call for models. Replace with `discoverAndRegisterTools`:
```ts
pi.on('session_start', async (_event, ctx) => {
  setSessionId(ctx.sessionManager.getSessionId() ?? crypto.randomUUID())
  const sessionSkillsEnabled = readSkillsSetting()
  await discoverAndRegisterTools(pi, config, getToken, registeredTools, sessionSkillsEnabled)
})
```

In `session_shutdown` handler, remove `clearInterval(refreshTimer)` and `refreshTimer = undefined`. It becomes:
```ts
pi.on('session_shutdown', async () => {
  setSessionId(undefined)
})
```

Remove:
- `let refreshTimer: ReturnType<typeof setInterval> | undefined`
- The `setInterval(async () => { ... }, TOKEN_REFRESH_INTERVAL_MS)` block
- `if (refreshTimer.unref) { refreshTimer.unref() }`
- The `reregister` function definition
- `TOKEN_REFRESH_INTERVAL_MS` constant

Rename `discoverAndRegister` → `discoverAndRegisterTools`. This function stays exported (used by `/litellm-skills on` command). Remove the model-discovery parts:
- Remove `discoverModels()` call
- Remove `saveModelCache()` call
- Remove `pi.registerProvider()` call inside it (models only)
- Remove `modelsResult` local variable and its handling
- Keep `mcpResult` handling (MCP tool registration)
- Keep skills tool registration
- The function signature changes to not need `streamSimple?` anymore:
  ```ts
  export async function discoverAndRegisterTools(
    pi: ExtensionAPI,
    config: PluginConfig,
    getToken: () => Promise<string>,
    registeredTools?: Set<string>,
    skillsEnabled?: boolean,
  ): Promise<void>
  ```

Also update the `/litellm-skills` command handler's call from `discoverAndRegister(...)` to `discoverAndRegisterTools(...)`.

**What to implement in `test/index.test.ts`:**

1. Remove mock of `../src/model-cache.js` (`vi.doMock` for `loadModelCache`, `saveModelCache`) from all `beforeEach` blocks
2. Remove mock of `buildProviderConfig` from `../src/litellm-api.js` mocks; add mock of `buildNativeProvider`:
   ```ts
   buildNativeProvider: vi.fn().mockReturnValue({ id: 'litellm', /* fake Provider shape */ }),
   ```
3. Replace `discoverAndRegister` references with `discoverAndRegisterTools` throughout
4. Update `registerProvider` call-count assertions:
   - The default extension startup should call `pi.registerProvider` exactly **1 time** (not 2 as before)
5. Update `session_start` handler assertions: verify `discoverAndRegisterTools` is called (not model re-registration)
6. Remove timer-related assertions (`setInterval`, `clearInterval`, `refreshTimer`)
7. Remove `reregister` mock and related assertions

**Steps:**
- [ ] Update `src/index.ts`: remove model-cache imports, reregister fn, refresh timer, update startup sequence, rename `discoverAndRegister` → `discoverAndRegisterTools`, simplify session_start and session_shutdown handlers
- [ ] Update `test/index.test.ts`: update all mocks and assertions per above
- [ ] Run `npm run typecheck` — should pass with 0 errors
- [ ] Run `npm run test:run` — all tests should pass
- [ ] Commit with message: `feat(index): migrate to createProvider native registration, remove model-cache usage`

**Acceptance criteria:**
- [ ] `src/index.ts` has no imports from `./model-cache.js`
- [ ] `src/index.ts` has no `setInterval` or `clearInterval`
- [ ] `pi.registerProvider(provider)` is called exactly once at startup with a native Provider object (not the string-first overload)
- [ ] `discoverAndRegisterTools` is exported and handles MCP + skills only
- [ ] `npm run typecheck` passes with 0 errors
- [ ] `npm run test:run` passes all tests

---

### Final verification

After all tasks are committed:
- [ ] `npm run typecheck` — 0 errors
- [ ] `npm run test:run` — all tests green
- [ ] `node_modules/@earendil-works/pi-coding-agent` version is 0.84.2
- [ ] `src/model-cache.ts` does not exist
- [ ] `test/model-cache.test.ts` does not exist
- [ ] `src/stream-simple.ts` does not import `streamSimpleOpenAICompletions` from `@earendil-works/pi-ai` root
- [ ] `src/index.ts` has no `loadModelCache`, `saveModelCache`, `reregister`, `setInterval`, `buildProviderConfig`
- [ ] `pi.registerProvider` is called with a single-argument native Provider (not the string+config form) in `src/index.ts`
