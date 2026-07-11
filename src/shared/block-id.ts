import { normalizeText } from './text'

/** FNV-1a 32-bit → base36, prefixed */
export function makeBlockId(tag: string, text: string, coarsePath: string): string {
  const payload = `${tag.toLowerCase()}|${normalizeText(text)}|${coarsePath}`
  let h = 0x811c9dc5
  for (let i = 0; i < payload.length; i++) {
    h ^= payload.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `b_${(h >>> 0).toString(36)}`
}
