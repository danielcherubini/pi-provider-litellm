import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { LiteLLMModelInfo } from './types.js'

const CACHE_FILENAME = 'pi-provider-litellm-cache.json'

interface ModelCache {
  savedAt: number
  providerId: string
  models: Record<string, LiteLLMModelInfo>
}

function getCachePath(): string {
  return path.join(os.homedir(), '.pi', 'agent', CACHE_FILENAME)
}

/**
 * Loads the model cache from disk. Returns null if the file does not exist or
 * cannot be parsed.
 */
export function loadModelCache(providerId: string): Record<string, LiteLLMModelInfo> | null {
  try {
    const raw = fs.readFileSync(getCachePath(), 'utf-8')
    const cache = JSON.parse(raw) as ModelCache

    // Ignore cache for a different provider
    if (cache.providerId !== providerId) return null
    if (!cache.models || typeof cache.models !== 'object') return null

    return cache.models
  } catch {
    return null
  }
}

/**
 * Saves the discovered models to the cache file on disk.
 */
export function saveModelCache(providerId: string, models: Record<string, LiteLLMModelInfo>): void {
  try {
    const cache: ModelCache = {
      savedAt: Date.now(),
      providerId,
      models,
    }
    fs.writeFileSync(getCachePath(), JSON.stringify(cache, null, 2), 'utf-8')
  } catch {
    // Non-fatal — discovery still succeeded, cache will be written next time
  }
}
