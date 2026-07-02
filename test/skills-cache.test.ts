import { describe, it, expect, vi, beforeEach } from 'vitest'
import { clearSkillsCache, getCacheAgeMinutes } from '../src/skills-cache.js'

const mockExistsSync = vi.hoisted(() => vi.fn())
const mockRmSync = vi.hoisted(() => vi.fn())
const mockReadFileSync = vi.hoisted(() => vi.fn())

vi.mock('node:fs', () => ({
  default: {
    get existsSync() { return mockExistsSync },
    get rmSync() { return mockRmSync },
    get readFileSync() { return mockReadFileSync },
    // Other fs functions referenced at module load / by unrelated exports
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    readdirSync: vi.fn(() => []),
  },
}))

describe('clearSkillsCache', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('is a no-op when cache dir does not exist', () => {
    mockExistsSync.mockReturnValue(false)
    expect(() => clearSkillsCache()).not.toThrow()
    expect(mockRmSync).not.toHaveBeenCalled()
  })

  it('deletes the cache dir when it exists', () => {
    mockExistsSync.mockReturnValue(true)
    clearSkillsCache()
    expect(mockRmSync).toHaveBeenCalledTimes(1)
    expect(mockRmSync).toHaveBeenCalledWith(
      expect.stringContaining('remote'),
      { recursive: true, force: true },
    )
  })
})

describe('getCacheAgeMinutes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns null when .meta.json does not exist', () => {
    mockExistsSync.mockReturnValue(false)
    expect(getCacheAgeMinutes()).toBeNull()
  })

  it('returns a number (minutes) when .meta.json exists with a recent timestamp', () => {
    mockExistsSync.mockReturnValue(true)
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000
    mockReadFileSync.mockReturnValue(JSON.stringify({ timestamp: tenMinutesAgo, skills: [] }))
    const age = getCacheAgeMinutes()
    expect(typeof age).toBe('number')
    expect(age).toBe(10)
  })
})
