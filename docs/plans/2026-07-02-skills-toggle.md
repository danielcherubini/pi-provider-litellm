# Skills Toggle Plan

**Goal:** Add an opt-in toggle for the remote skills feature, controllable via `settings.json` (`litellm.skills`) and a `/litellm-skills on|off|status` slash command.

**Architecture:** A new `readSkillsSetting()` helper reads `~/.pi/agent/settings.json` for `litellm.skills` (default `false`). The startup flow gates `syncRemoteSkills()` and `skill_list` tool registration behind this flag. A `/litellm-skills` slash command lets users enable/disable at runtime, persisting the setting back to `settings.json` and triggering an immediate sync (on) or cache wipe (off).

**Tech Stack:** TypeScript, Node.js `fs`, pi ExtensionAPI (`registerCommand`), vitest

---

### Task 1: Add settings helpers and cache utilities

**Context:**
This task adds the pure utility functions that the rest of the feature depends on. `readSkillsSetting()` reads the `litellm.skills` boolean from `~/.pi/agent/settings.json` (defaulting to `false` if missing, malformed, or not strictly `true`). `writeSkillsSetting(enabled)` reads the full settings.json, merges `{ litellm: { skills: enabled } }`, and writes it back — preserving all other keys. Both live in `src/litellm-api.ts` next to `resolvePluginConfig()`.

Three cache helpers go into `src/skills-cache.ts`: `clearSkillsCache()` removes the entire `~/.pi/agent/skills/remote/` directory (called when disabling); `getCacheAgeMinutes()` returns the age of the cache in minutes (for the status command), returning `null` if no cache exists. Both are added next to the existing cache logic.

**Files:**
- Modify: `src/litellm-api.ts`
- Modify: `src/skills-cache.ts`
- Modify: `test/litellm-api.test.ts`
- Create: `test/skills-cache.test.ts` (check with `ls test/` first — create only if absent)

**What to implement:**

In `src/litellm-api.ts`, add after `resolvePluginConfig()`:

```typescript
/**
 * Read the skills enabled flag from ~/.pi/agent/settings.json.
 * Returns false if the file is missing, unreadable, or the flag is not explicitly true.
 */
export function readSkillsSetting(): boolean {
  try {
    const settingsPath = path.join(os.homedir(), '.pi', 'agent', 'settings.json')
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
    const litellm = settings['litellm']
    if (typeof litellm !== 'object' || litellm === null) return false
    return (litellm as Record<string, unknown>)['skills'] === true
  } catch {
    return false
  }
}

/**
 * Write the skills enabled flag to ~/.pi/agent/settings.json.
 * Reads the existing file, merges the litellm.skills key, and writes it back.
 * Preserves all other existing settings. Guards against non-object litellm value.
 */
export function writeSkillsSetting(enabled: boolean): void {
  const settingsPath = path.join(os.homedir(), '.pi', 'agent', 'settings.json')
  let settings: Record<string, unknown> = {}
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
  } catch {
    // File missing or unreadable — start fresh
  }
  const existing = settings['litellm']
  const litellm: Record<string, unknown> =
    typeof existing === 'object' && existing !== null
      ? { ...(existing as Record<string, unknown>) }
      : {}
  settings['litellm'] = { ...litellm, skills: enabled }
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
}
```

In `src/skills-cache.ts`, add after the existing exports:

```typescript
/**
 * Delete all cached remote skills from disk.
 * Called when the user disables the skills feature via /litellm-skills off.
 */
export function clearSkillsCache(): void {
  if (fs.existsSync(CACHE_DIR)) {
    fs.rmSync(CACHE_DIR, { recursive: true, force: true })
  }
}

/**
 * Return the age of the skills cache in minutes, or null if no cache exists.
 * Used by the /litellm-skills status command.
 */
export function getCacheAgeMinutes(): number | null {
  try {
    if (!fs.existsSync(CACHE_META)) return null
    const meta = JSON.parse(fs.readFileSync(CACHE_META, 'utf-8')) as CacheMeta
    return Math.round((Date.now() - meta.timestamp) / 60000)
  } catch {
    return null
  }
}
```

Note: `CACHE_META` is already a module-level constant in `src/skills-cache.ts`. It does NOT need to be exported — `getCacheAgeMinutes()` is in the same file and can reference it directly.

**Steps:**
- [ ] Run `npm run test:run` to establish a baseline (all existing tests should pass)
- [ ] Add tests for `readSkillsSetting` in `test/litellm-api.test.ts` (look at existing describe blocks and follow the same mock pattern — the file already mocks `fs`):
  - Test: returns `false` when settings.json doesn't exist (fs throws)
  - Test: returns `false` when `litellm` key is missing from settings
  - Test: returns `false` when `litellm.skills` is `false`
  - Test: returns `true` when `litellm.skills` is `true`
  - Test: returns `false` when `litellm.skills` is a non-boolean truthy value (e.g. `"yes"`, `1`)
  - Test: returns `false` when `litellm` is a non-object value (e.g. a string)
- [ ] Add tests for `writeSkillsSetting` in `test/litellm-api.test.ts`:
  - Test: creates settings.json with `litellm.skills: true` when file doesn't exist (fs throws on read)
  - Test: merges into existing settings.json without clobbering other top-level keys (e.g. `defaultModel` survives)
  - Test: preserves other keys inside an existing `litellm` object (e.g. `litellm.timeout` survives)
  - Test: can set skills to `false`
  - Test: handles malformed `litellm` value (e.g. `litellm` is a string) — should replace it with `{ skills: true }` rather than throwing
- [ ] Run `npm run test:run` — expect new tests to fail with "not exported" or similar
- [ ] Implement `readSkillsSetting()` and `writeSkillsSetting()` in `src/litellm-api.ts`
- [ ] Check if `test/skills-cache.test.ts` exists (`ls test/`). If not, create it with:
  - A `describe('clearSkillsCache', ...)` block with:
    - Test: is a no-op when cache dir doesn't exist (no error thrown)
    - Test: deletes the cache dir when it exists
  - A `describe('getCacheAgeMinutes', ...)` block with:
    - Test: returns `null` when `.meta.json` doesn't exist
    - Test: returns a number (minutes) when `.meta.json` exists with a recent timestamp
  - Follow the same `vi.mock('node:fs', ...)` pattern used in `test/gcloud-token.test.ts` or `test/litellm-api.test.ts`
- [ ] Implement `clearSkillsCache()` and `getCacheAgeMinutes()` in `src/skills-cache.ts`
- [ ] Run `npm run test:run` — all tests should pass
- [ ] Run `npm run typecheck`
- [ ] Commit: `feat: add readSkillsSetting, writeSkillsSetting, clearSkillsCache, getCacheAgeMinutes helpers`

**Acceptance criteria:**
- [ ] `readSkillsSetting()` returns `false` by default (no file, missing key, non-boolean, non-object litellm value)
- [ ] `readSkillsSetting()` returns `true` only when `litellm.skills === true` (strict equality)
- [ ] `writeSkillsSetting(true/false)` merges cleanly without losing other settings keys or other litellm keys
- [ ] `writeSkillsSetting()` handles non-object `litellm` value without throwing
- [ ] `clearSkillsCache()` removes `~/.pi/agent/skills/remote/` without throwing if absent
- [ ] `getCacheAgeMinutes()` returns `null` if no cache, or age in minutes if cache exists
- [ ] All tests pass, typecheck clean

---

### Task 2: Gate skills on startup behind the setting

**Context:**
Currently `src/index.ts` always calls `syncRemoteSkills()` at startup and always registers the `skill_list` tool in `discoverAndRegister()`. This task adds the flag check so both actions are skipped when `readSkillsSetting()` returns `false`.

The `discoverAndRegister` function gets a new optional 6th parameter `skillsEnabled?: boolean` (defaults to `false` if omitted — this is intentional: callers that don't pass the flag get skills off). The flag guards the skill tools registration block inside `discoverAndRegister`.

**Important for tests:** The existing tests in `test/index.test.ts` that assert skill tools ARE registered (e.g. "registers skill tools even when MCP discovery fails", "failed MCP discovery does not prevent skill tool registration") currently call `discoverAndRegister` without a 6th argument. After this change, those calls will get `skillsEnabled = false` and skill tools won't register. Those tests MUST be updated to pass `true` as the 6th argument (or mock `readSkillsSetting`). Check `test/index.test.ts` for all calls to `discoverAndRegister` and update them explicitly.

The `session_start` event handler must re-read `readSkillsSetting()` fresh each time (not capture the value from the outer closure) — this ensures that if the user enables skills via `/litellm-skills on` during a session, the next `session_start` picks up the new value.

**Files:**
- Modify: `src/index.ts`
- Modify: `test/index.test.ts`

**What to implement:**

In `src/index.ts`:

1. Add `readSkillsSetting` to the import from `./litellm-api.js`
2. In the default export function, read the flag once for startup:
   ```typescript
   const skillsEnabled = readSkillsSetting()
   ```
3. Gate the `syncRemoteSkills` call (currently unconditional):
   ```typescript
   if (skillsEnabled) {
     await syncRemoteSkills(config.url, getToken, (msg) => console.log(msg))
   }
   ```
4. Add `skillsEnabled` as optional 6th parameter to `discoverAndRegister`:
   ```typescript
   export async function discoverAndRegister(
     pi: ExtensionAPI,
     config: PluginConfig,
     getToken: () => Promise<string>,
     streamSimple?: StreamSimpleFn,
     registeredTools?: Set<string>,
     skillsEnabled?: boolean,   // NEW — defaults to false if omitted
   ): Promise<void>
   ```
5. Inside `discoverAndRegister`, wrap the skill tools block:
   ```typescript
   if (skillsEnabled) {
     const skillTools = createSkillToolDefinitions()
     for (const tool of skillTools) {
       if (!registeredTools || !registeredTools.has(tool.name)) {
         pi.registerTool(tool)
         registeredTools?.add(tool.name)
       }
     }
   }
   ```
6. Update the startup call to `discoverAndRegister` to pass `skillsEnabled`.
7. In the `session_start` handler, re-read the setting fresh (do NOT use the outer closure value):
   ```typescript
   pi.on('session_start', async (_event, ctx) => {
     setSessionId(ctx.sessionManager.getSessionId() ?? crypto.randomUUID())
     const sessionSkillsEnabled = readSkillsSetting()  // re-read here
     await discoverAndRegister(pi, config, getToken, streamSimple, registeredTools, sessionSkillsEnabled)
   })
   ```

**Steps:**
- [ ] Run `npm run test:run` to establish baseline — note which tests currently pass
- [ ] Open `test/index.test.ts` and find all calls to `discoverAndRegister`. For each call that expects `skill_list` tool to be registered, add `true` as the 6th argument. Add new tests:
  - Test: when `skillsEnabled` is `false` (or omitted), `skill_list` tool is NOT registered
  - Test: when `skillsEnabled` is `true`, `skill_list` tool IS registered
  - Test: when `skillsEnabled` is `false`, MCP tools still register normally (skills flag doesn't affect MCP)
- [ ] Run `npm run test:run` — new tests should fail, existing updated tests should pass
- [ ] Implement the changes in `src/index.ts` as described above
- [ ] Run `npm run test:run` — all tests should pass
- [ ] Run `npm run typecheck`
- [ ] Commit: `feat: gate skills sync and skill_list tool behind litellm.skills setting`

**Acceptance criteria:**
- [ ] When `litellm.skills` is absent from settings.json, skills are NOT synced and `skill_list` is NOT registered at startup
- [ ] When `litellm.skills: true`, behavior is identical to the original always-on behavior
- [ ] `session_start` re-reads the setting fresh (not captured from startup closure)
- [ ] `discoverAndRegister` signature change is backwards-compatible (`skillsEnabled` is optional, defaults to `false`)
- [ ] MCP tools continue to register regardless of the skills flag
- [ ] All tests pass, typecheck clean

---

### Task 3: Register the `/litellm-skills` slash command

**Context:**
This task wires up the `/litellm-skills` command in `src/index.ts`. The command has three sub-commands: `on`, `off`, and `status`. It is registered via `pi.registerCommand()` inside the plugin's default export function, after the event registrations.

`ctx.ui.notify()` only accepts `"info" | "warning" | "error"` — `'success'` is NOT a valid type and will cause a TypeScript error. Use `'info'` for all notifications.

The command does NOT unregister the `skill_list` tool at runtime when turning off — pi's tool registry doesn't support unregistering. Turning off just persists the setting, clears the disk cache, and notifies the user that the tool disappears after restart.

**Files:**
- Modify: `src/index.ts`

**What to implement:**

First, check what is already imported in `src/index.ts`. Then add any missing imports:
- `writeSkillsSetting`, `readSkillsSetting` from `./litellm-api.js` (may already be partially there after Task 2)
- `clearSkillsCache`, `getCachedSkillNames`, `getCacheAgeMinutes` from `./skills-cache.js`
- `syncRemoteSkills` is already imported
- `path`, `fs`, `os` from Node built-ins — check existing imports, avoid duplicates

In the plugin default export function, after the event registrations, add:

```typescript
pi.registerCommand('litellm-skills', {
  description: 'Toggle remote skill syncing: on | off | status',
  handler: async (args: string, ctx) => {
    const sub = args.trim().toLowerCase()

    if (sub === 'on') {
      writeSkillsSetting(true)
      ctx.ui.notify('Skills enabled — syncing now…', 'info')
      await syncRemoteSkills(config.url, getToken, (msg) => console.log(msg))
      const names = getCachedSkillNames()
      ctx.ui.notify(`Skills ready: ${names.length} skills cached`, 'info')
      return
    }

    if (sub === 'off') {
      writeSkillsSetting(false)
      clearSkillsCache()
      ctx.ui.notify('Skills disabled — cache cleared. The skill_list tool will be removed on next restart.', 'info')
      return
    }

    if (sub === 'status') {
      const enabled = readSkillsSetting()
      const names = getCachedSkillNames()
      const ageMin = getCacheAgeMinutes()
      const ageStr = ageMin !== null ? `${ageMin}m ago` : 'n/a'
      const lines = [
        `Skills: ${enabled ? '✅ enabled' : '❌ disabled'}`,
        `Cached skills: ${names.length}`,
        `Cache age: ${ageStr}`,
      ]
      ctx.ui.notify(lines.join('\n'), 'info')
      return
    }

    // No args or unrecognised
    ctx.ui.notify('Usage: /litellm-skills on | off | status', 'info')
  },
})
```

**Steps:**
- [ ] Run `npm run test:run` baseline
- [ ] Implement the `pi.registerCommand('litellm-skills', ...)` block in `src/index.ts`
- [ ] Add any missing imports (check existing imports first — avoid duplicates)
- [ ] Run `npm run typecheck` — fix any type errors (the `args` parameter type is `string`, `ctx` is `ExtensionCommandContext`)
- [ ] Run `npm run test:run` — all existing tests should still pass
- [ ] Manual smoke test (start pi and try each sub-command):
  - `/litellm-skills status` — shows current state, skill count, cache age
  - `/litellm-skills on` — enables, syncs, shows count
  - `/litellm-skills off` — disables, clears cache, shows restart note
  - `/litellm-skills` (no args) — shows usage hint
  - `/litellm-skills bogus` — shows usage hint
- [ ] Commit: `feat: add /litellm-skills on|off|status command`

**Acceptance criteria:**
- [ ] `/litellm-skills on` persists `litellm.skills: true` to settings.json and syncs immediately
- [ ] `/litellm-skills off` persists `litellm.skills: false` and deletes `~/.pi/agent/skills/remote/`
- [ ] `/litellm-skills status` shows enabled state, skill count, and cache age via `getCacheAgeMinutes()`
- [ ] `/litellm-skills` (no args) and unrecognised args both show usage hint
- [ ] `ctx.ui.notify()` is only called with valid types (`"info"`, `"warning"`, or `"error"`) — `'success'` is NOT valid
- [ ] All existing tests pass, typecheck clean
