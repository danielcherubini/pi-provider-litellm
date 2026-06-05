import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { LiteLLMModelInfo } from './types.js'

const LOG = '[pi-provider-litellm]'
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

    const ageMs = Date.now() - (cache.savedAt ?? 0)
    const ageMins = Math.round(ageMs / 60_000)
    console.log(`${LOG} Loaded ${Object.keys(cache.models).length} model(s) from cache (${ageMins}m old)`)
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
    console.log(`${LOG} Saved ${Object.keys(models).length} model(s) to cache`)
  } catch (err) {
    console.warn(`${LOG} Failed to save model cache: ${err}`)
  }
}
