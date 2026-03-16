/**
 * Hybrid Logical Clock (HLC) — causally ordered timestamps.
 * Factory function returning a clock instance.
 * @returns {{ now: () => HLCTimestamp, update: (ts: HLCTimestamp) => void, compare: (a: HLCTimestamp, b: HLCTimestamp) => number }}
 */
export function HybridClock() {
  let physical = Date.now()
  let logical = 0

  return {
    /** @returns {{ physical: number, logical: number }} */
    now() {
      physical = Math.max(physical, Date.now())
      logical++
      return { physical, logical }
    },

    /** @param {{ physical: number, logical: number }} remote */
    update(remote) {
      if (!remote || typeof remote.physical !== 'number' || typeof remote.logical !== 'number') return
      physical = Math.max(physical, remote.physical)
      logical = Math.max(logical, remote.logical) + 1
    },

    /** @returns {number} 1 if a > b, -1 if a < b, 0 if equal */
    compare(a, b) {
      if (!a && !b) return 0
      if (!a) return -1
      if (!b) return 1
      if (a.physical !== b.physical) return a.physical > b.physical ? 1 : -1
      if (a.logical !== b.logical) return a.logical > b.logical ? 1 : -1
      return 0
    }
  }
}
