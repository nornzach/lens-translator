export function isHostnamePaused(hostname: string, paused: string[]): boolean {
  return paused.includes(hostname)
}
