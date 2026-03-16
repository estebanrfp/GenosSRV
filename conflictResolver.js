const MAX_FUTURE_DRIFT_MS = 7200000

/**
 * Resolve conflict between local node and incoming remote change.
 * Last-Write-Wins (LWW) at object level.
 * @param {{ value: any, timestamp: any }|null} local
 * @param {{ value: any, timestamp: any }} remote
 * @param {{ compare: Function }} clock
 * @returns {{ resolved: boolean, value?: any, timestamp?: any }}
 */
export function resolveConflict(local, remote, clock) {
  let ts = remote.timestamp

  // Cap future drift
  if (ts?.physical > Date.now() + MAX_FUTURE_DRIFT_MS) {
    ts = { physical: Date.now() + MAX_FUTURE_DRIFT_MS, logical: ts.logical }
  }

  // Priority changes (role assignments)
  if (remote?.value?.priority === true && typeof remote.id === 'string' && remote.id.startsWith('user:') && 'role' in remote.value) {
    const { priority, ...value } = remote.value
    return { resolved: true, value, timestamp: ts }
  }

  // Strip priority flag
  if (remote?.value?.priority !== undefined) {
    const { priority, ...value } = remote.value
    remote = { ...remote, value }
  }

  // No local → accept remote
  if (!local?.timestamp) return { resolved: true, value: remote.value, timestamp: ts }

  // Local newer or equal → reject
  if (clock.compare(ts, local.timestamp) <= 0) return { resolved: false }

  // Remote wins (LWW)
  return { resolved: true, value: remote.value, timestamp: ts }
}
