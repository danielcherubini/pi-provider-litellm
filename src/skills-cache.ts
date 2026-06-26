/**
 * Remote skill caching: fetches skills from the /opencode API and writes
 * them to a local directory so pi can discover them natively.
 *
 * Pi scans ~/.pi/agent/skills/ for SKILL.md files on startup. By writing
 * remote skills to ~/.pi/agent/skills/remote/, they appear in <available_skills>
 * and the agent can read them directly with real file paths (preserving
 * relative path references inside skill files).
 *
 * Cache lifecycle:
 * - On first run (or after TTL expiry): fetch from remote, write to disk
 * - TTL: 30 minutes (metadata check only, not re-fetching content)
 * - Stale skills (removed from remote) are pruned on next sync
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fetchSkillList, fetchSkillContent, type OpenCodeSkillEntry } from './opencode-api.js'

export const CACHE_DIR = path.join(os.homedir(), '.pi', 'agent', 'skills', 'remote')
const CACHE_META = path.join(CACHE_DIR, '.meta.json')
const CACHE_TTL_MS = 30 * 60 * 1000 // 30 minutes
const FETCH_BATCH_SIZE = 10

interface CacheMeta {
  timestamp: number
  skills: { name: string }[]
}

/** Ensure the cache directory exists. */
function ensureCacheDir(): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true })
}

/** Load cached metadata, or null if missing/expired. */
function loadCache(): CacheMeta | null {
  try {
    if (!fs.existsSync(CACHE_META)) return null
    const meta = JSON.parse(fs.readFileSync(CACHE_META, 'utf-8')) as CacheMeta
    if (Date.now() - meta.timestamp > CACHE_TTL_MS) return null
    return meta
  } catch {
    return null
  }
}

/** Persist metadata to disk. */
function saveCache(meta: CacheMeta): void {
  ensureCacheDir()
  fs.writeFileSync(CACHE_META, JSON.stringify(meta, null, 2))
}

/** Validate skill name per Agent Skills spec (lowercase a-z, 0-9, hyphens). */
function isValidSkillName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(name) && !name.startsWith('-') && !name.endsWith('-')
}

/** Write a single skill's SKILL.md to the cache. Returns the file path. */
function writeSkill(skill: OpenCodeSkillEntry, content: string): string {
  ensureCacheDir()
  const skillDir = path.join(CACHE_DIR, skill.name)
  fs.mkdirSync(skillDir, { recursive: true })
  const filePath = path.join(skillDir, 'SKILL.md')
  fs.writeFileSync(filePath, content)
  return filePath
}

/** Remove cached skill directories that no longer exist on the remote. */
function pruneStaleSkills(knownNames: Set<string>): void {
  if (!fs.existsSync(CACHE_DIR)) return
  const entries = fs.readdirSync(CACHE_DIR, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (knownNames.has(entry.name)) continue
    fs.rmSync(path.join(CACHE_DIR, entry.name), { recursive: true, force: true })
  }
}

export interface SyncResult {
  count: number
  names: string[]
  errored: string[]
}

/**
 * Sync remote skills to the local cache.
 *
 * Uses cache if within TTL. Otherwise fetches from remote, writes SKILL.md
 * files to CACHE_DIR, and saves metadata.
 *
 * Pi discovers these automatically from ~/.pi/agent/skills/remote/.
 */
export async function syncRemoteSkills(
  url: string,
  getToken: () => Promise<string>,
  log: (msg: string) => void = console.log,
): Promise<SyncResult> {
  const token = await getToken()
  if (!token) {
    log('[pi-provider-litellm] No token available — skipping remote skill sync')
    return { count: 0, names: [], errored: [] }
  }

  // Check cache first
  const cached = loadCache()
  if (cached) {
    const ageMin = Math.round((Date.now() - cached.timestamp) / 60000)
    log(`[pi-provider-litellm] Remote skills: using cache (${cached.skills.length} skills, ${ageMin}m old)`)
    return { count: cached.skills.length, names: cached.skills.map(s => s.name), errored: [] }
  }

  log('[pi-provider-litellm] Fetching remote skill list...')
  const entries = await fetchSkillList(url, token, log)
  if (!entries.length) {
    log('[pi-provider-litellm] No skills found on remote (check logs above for errors)')
    return { count: 0, names: [], errored: [] }
  }

  ensureCacheDir()

  const names: string[] = []
  const errored: string[] = []

  type FetchResult = { entry: OpenCodeSkillEntry; content: string | null; error: string | null }

  // Fetch in batches to avoid overwhelming the server
  for (let i = 0; i < entries.length; i += FETCH_BATCH_SIZE) {
    const batch = entries.slice(i, i + FETCH_BATCH_SIZE)
    const results = await Promise.allSettled<FetchResult>(
      batch.map(async (entry) => {
        // Validate name before using in filesystem paths (untrusted remote input)
        if (!isValidSkillName(entry.name)) {
          return { entry, content: null, error: 'invalid name' }
        }
        const content = await fetchSkillContent(url, token, entry.name, log)
        return { entry, content, error: null }
      }),
    )

    for (const result of results) {
      if (result.status !== 'fulfilled') {
        errored.push('unknown')
        continue
      }

      const { entry, content, error } = result.value

      if (error === 'invalid name') {
        errored.push(entry.name)
        log(`[pi-provider-litellm] Warning: skipping skill with invalid name "${entry.name}"`)
        continue
      }

      if (content) {
        writeSkill(entry, content)
        names.push(entry.name)
      } else {
        errored.push(entry.name)
        log(`[pi-provider-litellm] Warning: failed to fetch skill "${entry.name}"`)
      }
    }
  }

  // Combine successful + errored (errored skills keep their cached content on disk)
  const allCached = [...names, ...errored]

  // Prune stale skills no longer on the remote (only if they have no cached content)
  pruneStaleSkills(new Set(allCached))

  // Save cache metadata — include errored skills so transient failures don't evict them
  saveCache({
    timestamp: Date.now(),
    skills: allCached.map(name => ({ name })),
  })

  const errorSuffix = errored.length ? ` (${errored.length} fetch errors)` : ''
  log(`[pi-provider-litellm] Cached ${names.length} remote skills to ${CACHE_DIR}${errorSuffix}`)

  return { count: names.length, names, errored }
}

/** Force refresh — bypass cache and re-fetch everything. */
export async function refreshRemoteSkills(
  url: string,
  getToken: () => Promise<string>,
  log: (msg: string) => void = console.log,
): Promise<SyncResult> {
  try {
    if (fs.existsSync(CACHE_META)) fs.unlinkSync(CACHE_META)
  } catch {
    // Ignore — will be recreated
  }
  return syncRemoteSkills(url, getToken, log)
}

/** Get the list of cached skill names (for the skill_list tool). */
export function getCachedSkillNames(): string[] {
  if (!fs.existsSync(CACHE_DIR)) return []
  return fs.readdirSync(CACHE_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map(e => e.name)
    .sort()
}

/** Get the local file path for a cached skill's SKILL.md. */
export function getCachedSkillPath(name: string): string | null {
  const filePath = path.join(CACHE_DIR, name, 'SKILL.md')
  return fs.existsSync(filePath) ? filePath : null
}
