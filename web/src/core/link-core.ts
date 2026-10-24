// Settings → Devices → Add app: the link code's countdown and spotting the device the app created.

/** Time left on a link code as m:ss (0:00 once expired). */
export function linkCountdown(expiresAt: number, now: number): string {
  const s = Math.max(0, Math.ceil((expiresAt - now) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

/** The first device that was not listed when the dialog opened (the app that redeemed the code), if any. */
export function linkedDevice<T extends { id: string }>(known: ReadonlySet<string>, devices: readonly T[]): T | undefined {
  return devices.find((d) => !known.has(d.id))
}

/**
 * The link code's expiry on this device's clock: the server's expiresAt shifted by the clock difference the
 * response's Date header shows (second resolution), so a skewed clock neither expires the code early nor late.
 */
export function linkDeadline(expiresAt: number, serverDate: string | null | undefined, now: number): number {
  const server = serverDate ? Date.parse(serverDate) : NaN
  // The header drops milliseconds: the server's clock was up to a second later, so count a second less.
  return Number.isFinite(server) ? now + Math.max(0, expiresAt - server - 1000) : expiresAt
}
