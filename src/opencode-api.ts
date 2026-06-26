/**
 * API client for the /opencode/skills endpoint.
 *
 * This replaces the broken /claude-code/plugins endpoint that the old
 * listSkills/fetchSkillContent functions in litellm-api.ts were hitting
 * (they returned 401 with the proxy token).
 */

const SKILL_LIST_TIMEOUT = 10_000
const SKILL_FETCH_TIMEOUT = 5_000

export interface OpenCodeSkillEntry {
  name: string
  files: string[]
}

interface OpenCodeSkillsResponse {
  skills: OpenCodeSkillEntry[]
}

async function fetchJson<T>(url: string, timeout: number, headers?: Record<string, string>, log?: (msg: string) => void): Promise<T | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)

    const res = await fetch(url, {
      headers,
      signal: controller.signal,
    })

    clearTimeout(timer)

    if (!res.ok) {
      const text = await res.text().catch(() => '(no body)')
      log?.(`[pi-provider-litellm] HTTP ${res.status} for ${url}: ${text.substring(0, 200)}`)
      return null
    }
    return (await res.json()) as T
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log?.(`[pi-provider-litellm] Fetch error for ${url}: ${msg}`)
    return null
  }
}

/**
 * Fetch the list of available skills (names + files).
 * Endpoint: GET /opencode/skills
 */
export async function fetchSkillList(
  url: string,
  token: string,
  log?: (msg: string) => void,
): Promise<OpenCodeSkillEntry[]> {
  const fullUrl = `${url}/opencode/skills`
  const res = await fetchJson<OpenCodeSkillsResponse>(
    fullUrl,
    SKILL_LIST_TIMEOUT,
    { Authorization: `Bearer ${token}` },
    log,
  )
  if (!res) return []
  if (!Array.isArray(res.skills)) {
    log?.(`[pi-provider-litellm] Unexpected skill list response shape: ${JSON.stringify(res).substring(0, 300)}`)
    return []
  }
  return res.skills
}

/**
 * Fetch the full SKILL.md content for a skill by name.
 * Endpoint: GET /opencode/skills/{name}/SKILL.md
 *
 * Returns the raw markdown text (including frontmatter).
 */
export async function fetchSkillContent(
  url: string,
  token: string,
  name: string,
  log?: (msg: string) => void,
): Promise<string | null> {
  const fullUrl = `${url}/opencode/skills/${encodeURIComponent(name)}/SKILL.md`
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SKILL_FETCH_TIMEOUT)

    const res = await fetch(fullUrl, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })

    clearTimeout(timer)

    if (!res.ok) {
      log?.(`[pi-provider-litellm] HTTP ${res.status} for ${fullUrl}`)
      return null
    }
    return await res.text()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log?.(`[pi-provider-litellm] Fetch error for ${fullUrl}: ${msg}`)
    return null
  }
}
