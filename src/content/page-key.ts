export function makePageKey(loc: Location = location): string {
  return `${loc.origin}${loc.pathname}`
}
