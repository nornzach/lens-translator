import { splitIntoBatches } from '../shared/batch'
import {
  buildTranslateUserPrompt,
  parseTranslateBatchResult,
} from '../shared/schema'
import type { TranslateBlock } from '../shared/messages'
import type { UserSettings } from '../shared/settings-defaults'
import { chatCompletionsJson } from './openai'

const SYSTEM = 'You are a precise translation engine. Output JSON only.'

export type TranslateAllResult =
  | { ok: true; translations: { id: string; translation: string }[] }
  | { ok: false; error: string; translations: { id: string; translation: string }[]; failedIds: string[] }

export async function translateAllBlocks(
  blocks: TranslateBlock[],
  settings: UserSettings,
  opts?: { useJsonSchema?: boolean; sleep?: (ms: number) => Promise<void> },
): Promise<TranslateAllResult> {
  const useJsonSchema = opts?.useJsonSchema ?? true
  const sleep = opts?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const batches = splitIntoBatches(blocks, settings.batchCharLimit, 40)
  const translations: { id: string; translation: string }[] = []
  const failedIds: string[] = []

  for (const batch of batches) {
    const allowed = new Set(batch.map((b) => b.id))
    let attempt = 0
    let batchOk = false
    let lastError = 'unknown'

    while (attempt < 3 && !batchOk) {
      attempt++
      const userPrompt = buildTranslateUserPrompt(
        settings.sourceLang,
        settings.targetLang,
        batch,
      )
      let result = await chatCompletionsJson({
        baseURL: settings.baseURL,
        apiKey: settings.apiKey,
        model: settings.model,
        systemPrompt: SYSTEM,
        userPrompt,
        useJsonSchema,
      })

      // one fallback without json_schema if format rejected
      if (!result.ok && result.status === 400 && useJsonSchema && attempt === 1) {
        result = await chatCompletionsJson({
          baseURL: settings.baseURL,
          apiKey: settings.apiKey,
          model: settings.model,
          systemPrompt: SYSTEM,
          userPrompt,
          useJsonSchema: false,
        })
      }

      if (!result.ok) {
        lastError = result.error
        if (result.status === 401 || result.status === 403) {
          return {
            ok: false,
            error: lastError,
            translations,
            failedIds: blocks.map((b) => b.id),
          }
        }
        if (result.status === 429 || (result.status && result.status >= 500)) {
          await sleep(200 * attempt)
          continue
        }
        break
      }

      let parsedJson: unknown
      try {
        parsedJson = JSON.parse(result.content)
      } catch {
        lastError = 'invalid JSON from model'
        continue
      }
      const parsed = parseTranslateBatchResult(parsedJson, allowed)
      if (!parsed.ok) {
        lastError = parsed.error
        continue
      }
      translations.push(...parsed.items)
      const got = new Set(parsed.items.map((i) => i.id))
      for (const b of batch) {
        if (!got.has(b.id)) failedIds.push(b.id)
      }
      batchOk = true
    }

    if (!batchOk) {
      for (const b of batch) failedIds.push(b.id)
      return { ok: false, error: lastError, translations, failedIds: [...new Set(failedIds)] }
    }
  }

  return failedIds.length
    ? { ok: false, error: 'partial failure', translations, failedIds: [...new Set(failedIds)] }
    : { ok: true, translations }
}

// session cache helpers
type CacheStore = Map<string, Map<string, string>> // pageKey -> id -> translation

const memoryCache: CacheStore = new Map()

export function getCached(pageKey: string, id: string): string | undefined {
  return memoryCache.get(pageKey)?.get(id)
}

export function putCached(
  pageKey: string,
  items: { id: string; translation: string }[],
): void {
  let m = memoryCache.get(pageKey)
  if (!m) {
    m = new Map()
    memoryCache.set(pageKey, m)
  }
  for (const it of items) m.set(it.id, it.translation)
}

export function filterUncached(
  pageKey: string,
  blocks: TranslateBlock[],
): { cached: { id: string; translation: string }[]; missing: TranslateBlock[] } {
  const cached: { id: string; translation: string }[] = []
  const missing: TranslateBlock[] = []
  for (const b of blocks) {
    const hit = getCached(pageKey, b.id)
    if (hit !== undefined) cached.push({ id: b.id, translation: hit })
    else missing.push(b)
  }
  return { cached, missing }
}
