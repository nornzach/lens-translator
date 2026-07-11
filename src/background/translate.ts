import { splitIntoBatches } from '../shared/batch'
import {
  buildTranslateUserPrompt,
  parseTranslateBatchResult,
} from '../shared/schema'
import type { TranslateBlock } from '../shared/messages'
import type { UserSettings } from '../shared/settings-defaults'
import { makeTranslationCacheKey } from '../shared/text-hash'
import { TranslationCache } from '../shared/translation-cache'
import { normalizeText } from '../shared/text'
import { chatCompletionsJson } from './openai'

const SYSTEM = 'You are a precise translation engine. Output JSON only.'

/** Global bounded cache shared across tabs/pages (keys include pageKey). */
const textCache = new TranslationCache({
  maxEntries: 2500,
  maxTotalChars: 800_000,
})

export type TranslateAllResult =
  | { ok: true; translations: { id: string; translation: string }[] }
  | {
      ok: false
      error: string
      translations: { id: string; translation: string }[]
      failedIds: string[]
    }

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
        provider: settings.provider,
        reasoningPref: settings.reasoningPref,
      })

      if (!result.ok && result.status === 400 && useJsonSchema && attempt === 1) {
        result = await chatCompletionsJson({
          baseURL: settings.baseURL,
          apiKey: settings.apiKey,
          model: settings.model,
          systemPrompt: SYSTEM,
          userPrompt,
          useJsonSchema: false,
          provider: settings.provider,
          reasoningPref: settings.reasoningPref,
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
        if (
          result.status === 429 ||
          (result.status !== undefined && result.status >= 500) ||
          result.status === undefined
        ) {
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
      if (parsed.items.length === 0 && batch.length > 0) {
        lastError = 'empty translation items'
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

export function getCachedTranslation(
  pageKey: string,
  sourceLang: string,
  targetLang: string,
  text: string,
): string | undefined {
  const key = makeTranslationCacheKey(pageKey, sourceLang, targetLang, text)
  return textCache.get(key)
}

export function putCachedByText(
  pageKey: string,
  sourceLang: string,
  targetLang: string,
  items: { text: string; translation: string }[],
): void {
  for (const it of items) {
    const key = makeTranslationCacheKey(pageKey, sourceLang, targetLang, it.text)
    textCache.set(key, it.translation)
  }
}

/**
 * Resolve cache hits by **normalized text** (not DOM id).
 * Dedupes API work: identical sentences → one missing representative.
 */
export function filterUncachedByText(
  pageKey: string,
  sourceLang: string,
  targetLang: string,
  blocks: TranslateBlock[],
): {
  cached: { id: string; translation: string }[]
  /** Unique texts only (one block per identical sentence). */
  missing: TranslateBlock[]
  /** hash → all block ids that share this text (for expanding results). */
  textHashToIds: Map<string, string[]>
  idToText: Map<string, string>
} {
  const cached: { id: string; translation: string }[] = []
  const missing: TranslateBlock[] = []
  const textHashToIds = new Map<string, string[]>()
  const idToText = new Map<string, string>()
  const seenMissingHash = new Set<string>()

  for (const b of blocks) {
    const norm = normalizeText(b.text)
    idToText.set(b.id, norm)
    const cacheKey = makeTranslationCacheKey(pageKey, sourceLang, targetLang, norm)
    const hit = textCache.get(cacheKey)
    if (hit !== undefined) {
      cached.push({ id: b.id, translation: hit })
      continue
    }

    // Group identical texts
    const h = cacheKey // full key already includes text hash
    const list = textHashToIds.get(h) ?? []
    list.push(b.id)
    textHashToIds.set(h, list)

    if (!seenMissingHash.has(h)) {
      seenMissingHash.add(h)
      // Representative for API (first id)
      missing.push({ id: b.id, tag: b.tag, text: norm })
    }
  }

  return { cached, missing, textHashToIds, idToText }
}

/** Expand API results for representative ids to every id sharing the same text. */
export function expandTranslationsToAllIds(
  pageKey: string,
  sourceLang: string,
  targetLang: string,
  representativeResults: { id: string; translation: string }[],
  idToText: Map<string, string>,
  textHashToIds: Map<string, string[]>,
): { id: string; translation: string }[] {
  const out: { id: string; translation: string }[] = []
  const written = new Set<string>()

  for (const r of representativeResults) {
    const text = idToText.get(r.id) ?? ''
    const cacheKey = makeTranslationCacheKey(pageKey, sourceLang, targetLang, text)
    textCache.set(cacheKey, r.translation)

    const ids = textHashToIds.get(cacheKey) ?? [r.id]
    for (const id of ids) {
      if (written.has(id)) continue
      written.add(id)
      out.push({ id, translation: r.translation })
    }
  }
  return out
}

/** Test helpers */
export function _resetTranslationCacheForTests(): void {
  textCache.clear()
}

export function _cacheStatsForTests(): { size: number; chars: number } {
  return { size: textCache.size, chars: textCache.charCount }
}

// Backward-compat names used by older tests — map id-only puts is no longer primary path
export function putCached(
  pageKey: string,
  items: { id: string; translation: string; text?: string }[],
  langs: { sourceLang: string; targetLang: string } = {
    sourceLang: 'en',
    targetLang: 'zh',
  },
): void {
  for (const it of items) {
    const text = it.text ?? it.id
    putCachedByText(pageKey, langs.sourceLang, langs.targetLang, [
      { text, translation: it.translation },
    ])
  }
}

export function getCached(
  pageKey: string,
  idOrText: string,
  langs: { sourceLang: string; targetLang: string } = {
    sourceLang: 'en',
    targetLang: 'zh',
  },
): string | undefined {
  return getCachedTranslation(pageKey, langs.sourceLang, langs.targetLang, idOrText)
}

export function filterUncached(
  pageKey: string,
  blocks: TranslateBlock[],
  langs: { sourceLang: string; targetLang: string } = {
    sourceLang: 'en',
    targetLang: 'zh',
  },
): { cached: { id: string; translation: string }[]; missing: TranslateBlock[] } {
  const r = filterUncachedByText(pageKey, langs.sourceLang, langs.targetLang, blocks)
  return { cached: r.cached, missing: r.missing }
}
