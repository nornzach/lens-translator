import { splitIntoBatches } from '../shared/batch'
import {
  buildTranslateImagePrompt,
  buildTranslateUserPrompt,
  IMAGE_TRANSLATION_JSON_SCHEMA,
  parseImageTranslationResult,
  parseTranslateBatchResult,
} from '../shared/schema'
import type { TranslateBlock } from '../shared/messages'
import type { UserSettings } from '../shared/settings-defaults'
import { makeTranslationCacheKey } from '../shared/text-hash'
import { TranslationCache } from '../shared/translation-cache'
import { normalizeText } from '../shared/text'
import { chatCompletionsJson } from './openai'
import type { ChatJsonParams } from './openai'

const SYSTEM = 'You are a precise translation engine. Output JSON only.'
const IMAGE_SYSTEM = 'You are a precise image text translation engine. Output JSON only.'
const MAX_IMAGE_BYTES = 4_000_000
const VISION_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

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

export type TranslateImageResult =
  | { ok: true; translation: string }
  | { ok: false; error: string }

/** Fetch and upload one complete page image to the configured multimodal endpoint. */
export async function translateImage(
  imageUrl: string,
  settings: UserSettings,
): Promise<TranslateImageResult> {
  const imageDataUrl = await loadImageDataUrl(imageUrl)
  if (!imageDataUrl.ok) return imageDataUrl

  const userPrompt = buildTranslateImagePrompt(settings.sourceLang, settings.targetLang)
  const request: Omit<ChatJsonParams, 'useJsonSchema'> = {
    baseURL: settings.baseURL,
    apiKey: settings.apiKey,
    model: settings.model,
    systemPrompt: IMAGE_SYSTEM,
    userPrompt,
    userContent: [
      { type: 'text', text: userPrompt },
      { type: 'image_url', image_url: { url: imageDataUrl.dataUrl } },
    ],
    jsonSchema: IMAGE_TRANSLATION_JSON_SCHEMA,
    provider: settings.provider,
    reasoningPref: settings.reasoningPref,
  }
  let result = await chatCompletionsJson({ ...request, useJsonSchema: true })

  if (!result.ok && result.status === 400) {
    result = await chatCompletionsJson({ ...request, useJsonSchema: false })
  }

  if (!result.ok) {
    return {
      ok: false,
      error:
        result.status === 400
          ? `当前模型或服务商不支持图片输入：${result.error}`
          : result.error,
    }
  }

  try {
    return parseImageTranslationResult(JSON.parse(result.content))
  } catch {
    return { ok: false, error: 'invalid JSON from model' }
  }
}

/** Read supported image bytes with a hard streaming limit before base64 encoding. */
async function loadImageDataUrl(
  imageUrl: string,
): Promise<{ ok: true; dataUrl: string } | { ok: false; error: string }> {
  if (imageUrl.startsWith('data:')) {
    const mimeType = imageUrl.slice(5).split(/[;,]/, 1)[0].toLowerCase()
    if (!VISION_IMAGE_TYPES.has(mimeType)) {
      return { ok: false, error: `unsupported image type: ${mimeType || 'unknown'}` }
    }
    if (!/^data:image\/(?:jpeg|png|webp|gif);base64,/i.test(imageUrl)) {
      return { ok: false, error: 'image data URL must use base64 encoding' }
    }
    if (imageUrl.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3)) {
      return { ok: false, error: 'image is too large (max 4 MB)' }
    }
    return { ok: true, dataUrl: imageUrl }
  }
  if (!/^https?:\/\//i.test(imageUrl)) {
    return { ok: false, error: 'unsupported image resource URL' }
  }

  let response: Response
  try {
    response = await fetch(imageUrl, { signal: AbortSignal.timeout(15_000) })
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'could not fetch image resource',
    }
  }
  if (!response.ok) return { ok: false, error: `image fetch failed: HTTP ${response.status}` }

  const mimeType = response.headers.get('content-type')?.split(';', 1)[0].toLowerCase() ?? ''
  if (!VISION_IMAGE_TYPES.has(mimeType)) {
    return { ok: false, error: `unsupported image type: ${mimeType || 'unknown'}` }
  }
  const declaredLength = Number(response.headers.get('content-length') ?? 0)
  if (declaredLength > MAX_IMAGE_BYTES) {
    return { ok: false, error: 'image is too large (max 4 MB)' }
  }

  if (!response.body) return { ok: false, error: 'image response body missing' }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      totalBytes += chunk.value.byteLength
      if (totalBytes > MAX_IMAGE_BYTES) {
        await reader.cancel()
        return { ok: false, error: 'image is too large (max 4 MB)' }
      }
      chunks.push(chunk.value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'image stream failed',
    }
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  let binary = ''
  for (let start = 0; start < bytes.length; start += 8192) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 8192))
  }
  return { ok: true, dataUrl: `data:${mimeType};base64,${btoa(binary)}` }
}

/** Translate batches with bounded retries and preserve partial successes. */
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

