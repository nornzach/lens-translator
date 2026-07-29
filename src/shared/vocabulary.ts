import { normalizeText } from './text'

/**
 * Vocabulary notebook ("生词本"). Stored in chrome.storage.local, written
 * directly from content scripts (storage API is available there) — no service
 * worker round-trip on the save hot path.
 */

export type VocabularyEntry = {
  id: string
  source: string
  translation: string
  sourceLang: string
  targetLang: string
  pageUrl: string
  /** Re-save of the same text+pair = review signal. */
  count: number
  createdAt: number
  lastSeenAt: number
}

export const VOCABULARY_STORAGE_KEY = 'lens-vocabulary-v1'
export const VOCABULARY_MAX_ENTRIES = 2000

function storageArea(): chrome.storage.StorageArea | undefined {
  try {
    return typeof chrome !== 'undefined' ? chrome.storage?.local : undefined
  } catch {
    return undefined
  }
}

function isVocabularyEntry(value: unknown): value is VocabularyEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.id === 'string' &&
    typeof entry.source === 'string' &&
    typeof entry.translation === 'string' &&
    typeof entry.sourceLang === 'string' &&
    typeof entry.targetLang === 'string' &&
    typeof entry.pageUrl === 'string' &&
    typeof entry.count === 'number' &&
    typeof entry.createdAt === 'number' &&
    typeof entry.lastSeenAt === 'number'
  )
}

/** Dedupe key: same normalized source text for the same language pair. */
export function vocabularyKey(source: string, sourceLang: string, targetLang: string): string {
  return `${sourceLang}\0${targetLang}\0${normalizeText(source).toLocaleLowerCase()}`
}

export type VocabularyInput = {
  source: string
  translation: string
  sourceLang: string
  targetLang: string
  pageUrl: string
}

/** Pure merge step (testable without chrome): add or bump an entry, then bound. */
export function upsertVocabularyEntry(
  entries: VocabularyEntry[],
  input: VocabularyInput,
  now: number,
  maxEntries = VOCABULARY_MAX_ENTRIES,
): { entries: VocabularyEntry[]; entry: VocabularyEntry } {
  const key = vocabularyKey(input.source, input.sourceLang, input.targetLang)
  const next = [...entries]
  const existingIndex = next.findIndex(
    (entry) => vocabularyKey(entry.source, entry.sourceLang, entry.targetLang) === key,
  )

  let entry: VocabularyEntry
  if (existingIndex >= 0) {
    const previous = next[existingIndex]
    entry = {
      ...previous,
      translation: input.translation || previous.translation,
      pageUrl: input.pageUrl || previous.pageUrl,
      count: previous.count + 1,
      lastSeenAt: now,
    }
    next.splice(existingIndex, 1)
  } else {
    entry = {
      id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      source: normalizeText(input.source),
      translation: input.translation,
      sourceLang: input.sourceLang,
      targetLang: input.targetLang,
      pageUrl: input.pageUrl,
      count: 1,
      createdAt: now,
      lastSeenAt: now,
    }
  }
  // Most-recently-seen first; evict least-recently-seen beyond the cap.
  next.unshift(entry)
  next.sort((a, b) => b.lastSeenAt - a.lastSeenAt)
  return { entries: next.slice(0, Math.max(1, maxEntries)), entry }
}

export async function loadVocabulary(): Promise<VocabularyEntry[]> {
  const area = storageArea()
  if (!area) return []
  try {
    const stored = await area.get(VOCABULARY_STORAGE_KEY)
    const raw = stored?.[VOCABULARY_STORAGE_KEY]
    if (!Array.isArray(raw)) return []
    return raw.filter(isVocabularyEntry)
  } catch {
    return []
  }
}

async function saveVocabulary(entries: VocabularyEntry[]): Promise<void> {
  const area = storageArea()
  if (!area) return
  try {
    await area.set({ [VOCABULARY_STORAGE_KEY]: entries })
  } catch {
    // Quota or context loss — saving words is best-effort.
  }
}

export async function addVocabularyEntry(input: VocabularyInput): Promise<VocabularyEntry | null> {
  const source = normalizeText(input.source)
  const translation = input.translation.trim()
  if (!source || !translation) return null
  const entries = await loadVocabulary()
  const { entries: next, entry } = upsertVocabularyEntry(entries, { ...input, source, translation }, Date.now())
  await saveVocabulary(next)
  return entry
}

export async function removeVocabularyEntry(id: string): Promise<void> {
  const entries = await loadVocabulary()
  await saveVocabulary(entries.filter((entry) => entry.id !== id))
}

export async function clearVocabulary(): Promise<void> {
  await saveVocabulary([])
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** Spreadsheet-friendly export. */
export function vocabularyToCsv(entries: VocabularyEntry[]): string {
  const rows = [
    'source,translation,source_lang,target_lang,count,created,last_seen,url',
    ...entries.map((entry) =>
      [
        entry.source,
        entry.translation,
        entry.sourceLang,
        entry.targetLang,
        String(entry.count),
        formatDate(entry.createdAt),
        formatDate(entry.lastSeenAt),
        entry.pageUrl,
      ]
        .map(csvCell)
        .join(','),
    ),
  ]
  return rows.join('\n')
}

/** Anki plain-text import (tab-separated, first two fields map to card sides). */
export function vocabularyToAnkiTsv(entries: VocabularyEntry[]): string {
  return entries
    .map((entry) =>
      [entry.source, entry.translation, `${entry.sourceLang}→${entry.targetLang} ${entry.pageUrl}`]
        .map((cell) => cell.replace(/\t/g, ' ').replace(/\n/g, ' '))
        .join('\t'),
    )
    .join('\n')
}
