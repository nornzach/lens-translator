import { describe, expect, it } from 'vitest'
import {
  upsertVocabularyEntry,
  vocabularyKey,
  vocabularyToAnkiTsv,
  vocabularyToCsv,
  type VocabularyEntry,
} from '../../src/shared/vocabulary'

const base = {
  source: 'ubiquitous',
  translation: '无处不在的',
  sourceLang: 'en',
  targetLang: 'zh',
  pageUrl: 'https://example.com/article',
}

describe('vocabularyKey', () => {
  it('normalizes whitespace and case', () => {
    expect(vocabularyKey('  Ubiquitous   Word ', 'en', 'zh')).toBe(
      vocabularyKey('ubiquitous word', 'en', 'zh'),
    )
    expect(vocabularyKey('word', 'en', 'zh')).not.toBe(vocabularyKey('word', 'en', 'ja'))
  })
})

describe('upsertVocabularyEntry', () => {
  it('adds a new entry to the front', () => {
    const { entries, entry } = upsertVocabularyEntry([], base, 1000)
    expect(entries).toHaveLength(1)
    expect(entry.count).toBe(1)
    expect(entry.createdAt).toBe(1000)
    expect(entries[0]).toBe(entry)
  })

  it('re-saving the same text bumps count and refreshes recency instead of duplicating', () => {
    const first = upsertVocabularyEntry([], base, 1000)
    const other = upsertVocabularyEntry(first.entries, { ...base, source: 'other word' }, 2000)
    const again = upsertVocabularyEntry(
      other.entries,
      { ...base, translation: '到处都是（修订）' },
      3000,
    )

    expect(again.entries).toHaveLength(2)
    const bumped = again.entries.find((e) => e.source === 'ubiquitous')!
    expect(bumped.count).toBe(2)
    expect(bumped.translation).toBe('到处都是（修订）')
    expect(bumped.lastSeenAt).toBe(3000)
    expect(bumped.createdAt).toBe(1000)
    // Most recently seen first
    expect(again.entries[0].source).toBe('ubiquitous')
  })

  it('evicts least-recently-seen beyond the cap', () => {
    let entries: VocabularyEntry[] = []
    for (let i = 0; i < 5; i++) {
      entries = upsertVocabularyEntry(
        entries,
        { ...base, source: `word-${i}` },
        1000 + i,
        3,
      ).entries
    }
    expect(entries).toHaveLength(3)
    expect(entries.map((e) => e.source)).toEqual(['word-4', 'word-3', 'word-2'])
  })
})

describe('vocabulary export', () => {
  const entry: VocabularyEntry = {
    id: 'x1',
    source: 'say "hello", world',
    translation: '说「你好」，世界',
    sourceLang: 'en',
    targetLang: 'zh',
    pageUrl: 'https://example.com',
    count: 2,
    createdAt: Date.UTC(2026, 0, 15),
    lastSeenAt: Date.UTC(2026, 0, 16),
  }

  it('escapes CSV cells containing commas, quotes and newlines', () => {
    const csv = vocabularyToCsv([entry])
    const [header, row] = csv.split('\n')
    expect(header).toBe('source,translation,source_lang,target_lang,count,created,last_seen,url')
    expect(row).toBe('"say ""hello"", world",说「你好」，世界,en,zh,2,2026-01-15,2026-01-16,https://example.com')
  })

  it('exports tab-separated Anki rows with source first', () => {
    const tsv = vocabularyToAnkiTsv([entry])
    expect(tsv).toBe('say "hello", world\t说「你好」，世界\ten→zh https://example.com')
  })
})
