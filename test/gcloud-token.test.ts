import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getGcloudToken, resetTokenCache, CACHE_TTL } from '../src/gcloud-token.js'

const mockReadFileSync = vi.hoisted(() => vi.fn())
const mockExistsSync = vi.hoisted(() => vi.fn())
const mockFetch = vi.hoisted(() => vi.fn())

vi.mock('fs', () => ({
  get readFileSync() { return mockReadFileSync },
  get existsSync() { return mockExistsSync },
}))

// Mock global fetch
beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

const authorizedUserCredentials = {
  type: 'authorized_user',
  client_id: 'test-client-id.apps.googleusercontent.com',
  client_secret: 'test-client-secret',
  refresh_token: 'test-refresh-token',
  account: 'test@example.com',
}

const serviceAccountCredentials = {
  type: 'service_account',
  private_key_id: 'key123',
  private_key: '-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n',
  client_email: 'test@project.iam.gserviceaccount.com',
  client_id: '123456789',
  auth_uri: 'https://accounts.google.com/o/oauth2/auth',
  token_uri: 'https://oauth2.googleapis.com/token',
}

describe('getGcloudToken', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    resetTokenCache()
  })

  it('returns token from authorized_user credentials', async () => {
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '/tmp/adc.json')
    vi.stubEnv('HOME', '/home/test')

    mockReadFileSync.mockReturnValue(JSON.stringify(authorizedUserCredentials))

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'exchanged-access-token' }),
    })

    const token = await getGcloudToken()
    expect(token).toBe('exchanged-access-token')

    expect(mockFetch).toHaveBeenCalledWith(
      'https://oauth2.googleapis.com/token',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }),
    )
  })

  it('caches token within TTL', async () => {
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '/tmp/adc.json')
    vi.stubEnv('HOME', '/home/test')

    mockReadFileSync.mockReturnValue(JSON.stringify(authorizedUserCredentials))
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'cached-token' }),
    })

    await getGcloudToken()
    const cached = await getGcloudToken()
    expect(cached).toBe('cached-token')
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('returns null when ADC file not found (no env, no default)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', undefined)
    vi.stubEnv('HOME', undefined)
    vi.stubEnv('USERPROFILE', undefined)
    vi.stubEnv('APPDATA', undefined)

    const token = await getGcloudToken()
    expect(token).toBeNull()
    expect(warnSpy).toHaveBeenCalled()

    warnSpy.mockRestore()
  })

  it('returns null when ADC file is invalid JSON', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '/tmp/adc.json')
    vi.stubEnv('HOME', '/home/test')

    mockReadFileSync.mockReturnValue('not valid json{{{')

    const token = await getGcloudToken()
    expect(token).toBeNull()
    expect(warnSpy).toHaveBeenCalled()

    warnSpy.mockRestore()
  })

  it('returns null and warns for service_account type', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '/tmp/adc.json')
    vi.stubEnv('HOME', '/home/test')

    mockReadFileSync.mockReturnValue(JSON.stringify(serviceAccountCredentials))

    const token = await getGcloudToken()
    expect(token).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(
      '[pi-provider-litellm] Service account credentials are not yet supported. Use an authorized_user credential or set GOOGLE_APPLICATION_CREDENTIALS to an authorized_user JSON file.',
    )

    warnSpy.mockRestore()
  })

  it('returns null on token exchange failure', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '/tmp/adc.json')
    vi.stubEnv('HOME', '/home/test')

    mockReadFileSync.mockReturnValue(JSON.stringify(authorizedUserCredentials))
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error":"invalid_grant"}',
    })

    const token = await getGcloudToken()
    expect(token).toBeNull()
    expect(warnSpy).toHaveBeenCalled()

    warnSpy.mockRestore()
  })

  it('returns null on token exchange network error', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '/tmp/adc.json')
    vi.stubEnv('HOME', '/home/test')

    mockReadFileSync.mockReturnValue(JSON.stringify(authorizedUserCredentials))
    mockFetch.mockRejectedValue(new Error('network error'))

    const token = await getGcloudToken()
    expect(token).toBeNull()
    expect(warnSpy).toHaveBeenCalled()

    warnSpy.mockRestore()
  })

  it('reads default ADC location when GOOGLE_APPLICATION_CREDENTIALS is not set', async () => {
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', undefined)
    vi.stubEnv('HOME', '/home/test')
    vi.stubEnv('APPDATA', undefined)

    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(JSON.stringify(authorizedUserCredentials))
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'default-loc-token' }),
    })

    const token = await getGcloudToken()
    expect(token).toBe('default-loc-token')
    expect(mockReadFileSync).toHaveBeenCalledWith(
      expect.stringContaining('application_default_credentials.json'),
      'utf-8',
    )
  })

  it('reads Windows APPDATA ADC location', async () => {
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', undefined)
    vi.stubEnv('HOME', undefined)
    vi.stubEnv('APPDATA', 'C:\\Users\\test\\AppData\\Roaming')

    mockExistsSync.mockImplementation((path: string) => {
      return typeof path === 'string' && path.includes('AppData') && path.includes('gcloud')
    })
    mockReadFileSync.mockReturnValue(JSON.stringify(authorizedUserCredentials))
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'windows-token' }),
    })

    const token = await getGcloudToken()
    expect(token).toBe('windows-token')
    expect(mockReadFileSync).toHaveBeenCalledWith(
      expect.stringContaining('gcloud'),
      'utf-8',
    )
  })

  it('respects GOOGLE_APPLICATION_CREDENTIALS path over default', async () => {
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '/custom/path/creds.json')
    vi.stubEnv('HOME', '/home/test')

    mockReadFileSync.mockReturnValue(JSON.stringify(authorizedUserCredentials))
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'custom-path-token' }),
    })

    const token = await getGcloudToken()
    expect(token).toBe('custom-path-token')
    expect(mockReadFileSync).toHaveBeenCalledWith('/custom/path/creds.json', 'utf-8')
  })

  it('stale cache triggers new token fetch', async () => {
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '/tmp/adc.json')
    vi.stubEnv('HOME', '/home/test')

    mockReadFileSync.mockReturnValue(JSON.stringify(authorizedUserCredentials))
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'token-v1' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'token-v2' }),
      })

    const first = await getGcloudToken()
    expect(first).toBe('token-v1')

    // Stub the cache to be stale
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + CACHE_TTL + 1000)

    const second = await getGcloudToken()
    expect(second).toBe('token-v2')
    expect(mockFetch).toHaveBeenCalledTimes(2)

    vi.restoreAllMocks()
  })
})
