import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

let cachedToken: string | null = null
let cachedAt: number = 0
let inflight: Promise<string | null> | null = null
export const CACHE_TTL = 50 * 60 * 1000 // 50 minutes in ms

interface AuthorizedUserCredentials {
  type: 'authorized_user'
  client_id: string
  client_secret: string
  refresh_token: string
  account?: string
  universe_domain?: string
}

interface ServiceAccountCredentials {
  type: 'service_account'
}

type GoogleCredentials = AuthorizedUserCredentials | ServiceAccountCredentials

const ADC_FILENAME = 'application_default_credentials.json'

function getAdcPath(): string | null {
  // 1. GOOGLE_APPLICATION_CREDENTIALS env var (all platforms)
  const envPath = typeof process !== 'undefined' ? process.env.GOOGLE_APPLICATION_CREDENTIALS : undefined
  if (envPath) {
    return envPath
  }

  // 2. Default ADC locations (Google's official search order)
  const candidates: string[] = []

  // Linux / macOS: ~/.config/gcloud/
  const home = typeof process !== 'undefined' ? process.env.HOME : undefined
  if (home) {
    candidates.push(join(home, '.config', 'gcloud', ADC_FILENAME))
  }

  // Windows: %APPDATA%/gcloud/
  const appData = typeof process !== 'undefined' ? process.env.APPDATA : undefined
  if (appData) {
    candidates.push(join(appData, 'gcloud', ADC_FILENAME))
  }

  for (const path of candidates) {
    if (existsSync(path)) {
      return path
    }
  }

  return null
}

function readCredentials(path: string): GoogleCredentials | null {
  try {
    const content = readFileSync(path, 'utf-8')
    return JSON.parse(content) as GoogleCredentials
  } catch {
    return null
  }
}

async function exchangeRefreshToken(credentials: AuthorizedUserCredentials): Promise<string | null> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: credentials.client_id,
    client_secret: credentials.client_secret,
    refresh_token: credentials.refresh_token,
  }).toString()

  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(10_000),
    })

    if (!response.ok) {
      const text = await response.text()
      console.warn(`[pi-provider-litellm] Token exchange failed (${response.status}): ${text}`)
      return null
    }

    const data = await response.json()
    return data.access_token || null
  } catch (error) {
    console.warn(`[pi-provider-litellm] Token exchange failed: ${error}`)
    return null
  }
}

/**
 * Gets a Google OAuth access token from the ADC JSON file, cached with a 50-minute TTL.
 * Concurrent calls share one in-flight request (request coalescing).
 * Returns null if credentials are not available or the token cannot be fetched.
 * Logs a warning on failure.
 */
export async function getGcloudToken(): Promise<string | null> {
  // Return cached token if still valid
  if (cachedToken && (Date.now() - cachedAt) < CACHE_TTL) {
    return cachedToken
  }

  // Coalesce concurrent calls: reuse the in-flight promise if one exists
  if (inflight) {
    return inflight
  }

  inflight = (async () => {
    try {
      const adcPath = getAdcPath()
      if (!adcPath) {
        console.warn(
          '[pi-provider-litellm] No Google ADC file found. Set GOOGLE_APPLICATION_CREDENTIALS or run `gcloud auth application-default login`.',
        )
        return null
      }

      const credentials = readCredentials(adcPath)
      if (!credentials) {
        console.warn(`[pi-provider-litellm] Failed to read ADC file: ${adcPath}`)
        return null
      }

      if (credentials.type === 'authorized_user') {
        const token = await exchangeRefreshToken(credentials)
        if (token) {
          cachedToken = token
          cachedAt = Date.now()
        }
        return token
      }

      if (credentials.type === 'service_account') {
        console.warn('[pi-provider-litellm] Service account credentials are not yet supported. Use an authorized_user credential or set GOOGLE_APPLICATION_CREDENTIALS to an authorized_user JSON file.')
        return null
      }

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      console.warn(`[pi-provider-litellm] Unknown credential type: ${(credentials as { type: string }).type}`)
      return null
    } finally {
      inflight = null
    }
  })()

  return inflight
}

/**
 * Pre-warms the token cache by fetching a token in the background.
 * Safe to call without awaiting — errors are swallowed since getGcloudToken logs them.
 */
export function warmGcloudToken(): void {
  void getGcloudToken()
}

/**
 * Resets the token cache. Exported for testing purposes.
 */
export function resetTokenCache(): void {
  cachedToken = null
  cachedAt = 0
  inflight = null
}
