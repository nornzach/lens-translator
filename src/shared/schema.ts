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
