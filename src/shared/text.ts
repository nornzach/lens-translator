export function normalizeText(input: string): string {
  return input.replace(/\s+/g, ' ').trim()
}

export function isTranslatableText(text: string, minLength: number): boolean {
  const t = normalizeText(text)
  if (t.length < minLength) return false
  // Must contain at least one letter (any script)
  if (!/\p{L}/u.test(t)) return false
  // Reject if almost no letters vs length (pure punctuation/numbers)
  const letters = t.match(/\p{L}/gu)?.length ?? 0
  if (letters / t.length < 0.3) return false
  return true
}
