import type { TranslateBlock } from './messages'

export const TRANSLATE_BATCH_JSON_SCHEMA = {
  name: 'translate_batch_result',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'translation'],
          properties: {
            id: { type: 'string' },
            translation: { type: 'string' },
          },
        },
      },
    },
  },
} as const

export const IMAGE_TRANSLATION_JSON_SCHEMA = {
  name: 'image_translation_result',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['translation'],
    properties: {
      translation: { type: 'string' },
    },
  },
} as const

export type TranslateBatchResult = {
  items: { id: string; translation: string }[]
}

export function parseTranslateBatchResult(
  raw: unknown,
  allowedIds: Set<string>,
): { ok: true; items: { id: string; translation: string }[] } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'not an object' }
  const items = (raw as { items?: unknown }).items
  if (!Array.isArray(items)) return { ok: false, error: 'items missing' }

  const out: { id: string; translation: string }[] = []
  for (const row of items) {
    if (!row || typeof row !== 'object') continue
    const id = (row as { id?: unknown }).id
    const translation = (row as { translation?: unknown }).translation
    if (typeof id !== 'string' || typeof translation !== 'string') continue
    if (!allowedIds.has(id)) continue
    out.push({ id, translation })
  }
  return { ok: true, items: out }
}

export function parseImageTranslationResult(
  raw: unknown,
): { ok: true; translation: string } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || !('translation' in raw)) {
    return { ok: false, error: 'translation missing' }
  }
  if (typeof raw.translation !== 'string' || !raw.translation.trim()) {
    return { ok: false, error: 'translation empty' }
  }
  return { ok: true, translation: raw.translation.trim() }
}

export function buildTranslateImagePrompt(sourceLang: string, targetLang: string): string {
  return [
    `Read visible text in this image and translate it from ${sourceLang} to ${targetLang}.`,
    'Preserve the original reading order and line breaks where meaningful.',
    'Do not describe the image. If it has no readable text, return an empty translation.',
    'Return ONLY JSON matching: { "translation": string }.',
  ].join('\n')
}

export function buildTranslateUserPrompt(
  sourceLang: string,
  targetLang: string,
  blocks: TranslateBlock[],
): string {
  return [
    `Translate each block from ${sourceLang} to ${targetLang}.`,
    'Return ONLY JSON matching the schema: { "items": [{ "id", "translation" }] }.',
    'Keep meaning faithful. No explanations.',
    'Blocks:',
    JSON.stringify(blocks),
  ].join('\n')
}
