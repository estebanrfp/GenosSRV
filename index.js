/**
 * GDB Server (Bun + SQLite fork)
 * Distributed graph database superpeer — peer-compatible with browser GenosDB.
 * Storage: bun:sqlite instead of filesystem. CRDT + delta/full sync + Oplog.
 */

import { Database } from 'bun:sqlite'
import { encode, decode } from '@msgpack/msgpack'
import pako from 'pako'
import { HybridClock } from './HybridClock.js'
import { resolveConflict } from './conflictResolver.js'
import { processNodes } from './Operators.js'
import { join } from './genosrtc-bun.js'
import { RTCPeerConnection } from 'webrtc-polyfill'

// ── Helpers ──

const deepClone = (v) => v && typeof v === 'object' ? structuredClone(v) : v

const createDebouncedTask = (action, delay = 16) => {
  let tid = null, deferred = null
  return (...args) => {
    deferred ??= Promise.withResolvers()
    if (tid !== null) clearTimeout(tid)
    tid = setTimeout(async () => {
      tid = null
      try { deferred.resolve(await action(...args)) }
      catch (e) { deferred.reject(e) }
      finally { deferred = null }
    }, delay)
    return deferred.promise
  }
}

const createDebouncedFn = (fn) => {
  let scheduled = false
  return () => {
    if (scheduled) return
    scheduled = true
    setImmediate(() => { scheduled = false; fn() })
  }
}

// ── Oplog ──

function Oplog(limit = 1000) {
  let ops = []
  return {
    add(op) { if (op?.timestamp) { ops.push(op); if (ops.length > limit) ops.splice(0, ops.length - limit) } },
    getOldest: () => ops[0] ?? null,
    getDelta: (since, cmp) => since ? ops.filter(op => cmp(op.timestamp, since) > 0) : [...ops],
    clear() { ops = [] },
    entries: () => [...ops],
    setEntries(e = []) { ops = Array.isArray(e) ? [...e] : []; if (ops.length > limit) ops.splice(0, ops.length - limit) }
  }
}

// ── Graph ──

function createGraph() {
  const state = { nodes: {} }
  return {
    get nodes() { return state.nodes },
    set nodes(n) { state.nodes = n ?? {} },
    upsert(id, value, timestamp) {
      const existing = state.nodes[id]
      state.nodes[id] = { id, value: deepClone(value), edges: existing?.edges ? [...existing.edges] : [], timestamp }
    },
    get: (id) => state.nodes[id] ?? null,
    link(src, tgt, ts) {
      const s = state.nodes[src], t = state.nodes[tgt]
      if (s && t && !s.edges.includes(tgt)) state.nodes[src] = { ...s, edges: [...s.edges, tgt], timestamp: ts }
    },
    getAllNodes: () => Object.values(state.nodes),
    serialize: () => pako.deflate(encode(state.nodes)),
    deserialize(data) {
      const u8 = data instanceof Uint8Array ? data : new Uint8Array(data)
      state.nodes = decode(pako.inflate(u8))
    }
  }
}

// ── SQLite Storage ──

/**
 * Create SQLite storage adapter
 * @param {string} dbPath - Path to SQLite database file
 * @param {string} name - Database name (room)
 */
function createStorage(dbPath, name) {
  const sqlite = new Database(dbPath)
  sqlite.exec('PRAGMA journal_mode = WAL')
  sqlite.exec('PRAGMA synchronous = NORMAL')
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value BLOB NOT NULL
    )
  `)

  const getStmt = sqlite.prepare('SELECT value FROM kv WHERE key = ?')
  const putStmt = sqlite.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)')
  const delStmt = sqlite.prepare('DELETE FROM kv WHERE key = ?')

  const prefix = name

  return {
    /** @param {string} key @returns {Uint8Array|null} */
    getBlob(key) {
      const row = getStmt.get(`${prefix}:${key}`)
      return row ? new Uint8Array(row.value) : null
    },

    /** @param {string} key @returns {string|null} */
    getText(key) {
      const row = getStmt.get(`${prefix}:${key}`)
      return row ? Buffer.from(row.value).toString('utf8') : null
    },

    /** @param {string} key @param {Uint8Array} value */
    putBlob(key, value) { putStmt.run(`${prefix}:${key}`, Buffer.from(value)) },

    /** @param {string} key @param {string} value */
    putText(key, value) { putStmt.run(`${prefix}:${key}`, Buffer.from(value, 'utf8')) },

    /** @param {string} key */
    del(key) { delStmt.run(`${prefix}:${key}`) },

    close() { sqlite.close() }
  }
}

// ── GDB Server Factory ──

/**
 * @param {string} [name] - Room/database name
 * @param {Object} [options]
 * @param {string} [dbPath] - SQLite database file path
 */
export async function gdbServer(
  name = process.env.GDB_ROOM || process.argv[2] || 'default',
  options = {},
  dbPath = process.env.GDB_DB_PATH || './data.sqlite'
) {
  console.info(`⚡ GDBServer [${name}] initializing (bun:sqlite)`)

  const { password, relayUrls = null, turnConfig = null, saveDelay = 200, oplogSize = 1000 } = options

  const graph = createGraph()
  const hybridClock = HybridClock()
  const oplog = Oplog(oplogSize)
  const storage = createStorage(dbPath, name)

  const eventListeners = []
  const messageMiddlewares = []
  const pendingOps = []

  let globalTimestamp = null
  let syncChannel = null
  let syncRoom = null

  const publicApi = {}

  // ── Storage Operations ──

  const loadGraph = () => {
    const data = storage.getBlob('graph')
    if (data?.byteLength) { graph.deserialize(data); console.info(`✅ Graph loaded: ${graph.getAllNodes().length} nodes`) }
  }

  const saveGraph = () => {
    storage.putBlob('graph', graph.serialize())
  }

  const loadTimestamp = () => {
    const raw = storage.getText('timestamp')
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed?.physical && parsed?.logical) { globalTimestamp = parsed; hybridClock.update(globalTimestamp) }
    }
  }

  const saveTimestamp = () => {
    storage.putText('timestamp', JSON.stringify(globalTimestamp ?? null))
  }

  const loadOplog = () => {
    const data = storage.getBlob('oplog')
    if (data?.byteLength) {
      const entries = decode(pako.inflate(data))
      if (Array.isArray(entries)) { oplog.setEntries(entries); console.info(`✅ Oplog loaded: ${entries.length} ops`) }
    }
  }

  const saveOplog = () => {
    storage.putBlob('oplog', pako.deflate(encode(oplog.entries())))
  }

  const updateGlobalTimestamp = (ts) => {
    if (!ts) return
    if (!globalTimestamp || hybridClock.compare(ts, globalTimestamp) > 0) {
      globalTimestamp = ts
      saveTimestamp()
    }
  }

  const scheduleSaveGraph = createDebouncedTask(() => saveGraph(), saveDelay)
  const scheduleSaveOplog = createDebouncedTask(() => saveOplog(), saveDelay)

  // ── Emit ──

  const emit = () => {
    const snapshot = { ...graph.nodes }
    eventListeners.forEach(fn => fn(snapshot))
  }
  const scheduleEmit = createDebouncedFn(() => emit())

  // ── Safe Send ──

  const safeSend = async (ops) => {
    if (!ops?.length || !syncChannel) return false
    try { await syncChannel.send(ops); return true }
    catch (e) { console.error('❌ safeSend failed:', e?.message); return false }
  }

  // ── Receive Changes ──

  const receiveChanges = async (changes) => {
    let changed = false, highest = null

    const updateHighest = (ts) => {
      if (ts && (!highest || hybridClock.compare(ts, highest) > 0)) highest = ts
    }

    const decodeOps = (raw) => {
      try {
        if (raw instanceof Uint8Array || raw instanceof ArrayBuffer) {
          const d = decode(raw); return Array.isArray(d) ? d : [d]
        }
        if (Array.isArray(raw)) return raw
        if (raw && typeof raw === 'object') return decode(pako.inflate(new Uint8Array(Object.values(raw))))
      } catch (e) { console.error('❌ decode failed', e) }
      return null
    }

    const apply = {
      upsert(c) {
        const { resolved, value, timestamp } = resolveConflict(graph.get(c.id), c, hybridClock)
        if (!resolved) return
        graph.upsert(c.id, value, timestamp)
        hybridClock.update(timestamp)
        oplog.add({ type: 'upsert', id: c.id, timestamp })
        changed = true; updateHighest(timestamp)
      },

      remove(c) {
        const local = graph.get(c.id)
        if (!local || hybridClock.compare(local.timestamp, c.timestamp) >= 0) return
        delete graph.nodes[c.id]
        Object.values(graph.nodes).forEach(n => { n.edges = (n.edges ?? []).filter(e => e !== c.id) })
        hybridClock.update(c.timestamp)
        oplog.add({ type: 'remove', id: c.id, timestamp: c.timestamp })
        changed = true; updateHighest(c.timestamp)
      },

      link(c) {
        const src = graph.get(c.sourceId), tgt = graph.get(c.targetId)
        if (!src || !tgt || hybridClock.compare(src.timestamp, c.timestamp) >= 0) return
        graph.link(c.sourceId, c.targetId, c.timestamp)
        hybridClock.update(c.timestamp)
        oplog.add({ type: 'link', ...c })
        changed = true; updateHighest(c.timestamp)
      },

      async sync({ timestamp: ts }) {
        const oldest = oplog.getOldest()
        const needFull = ts == null || (oldest && hybridClock.compare(ts, oldest.timestamp) < 0)
        if (needFull) {
          console.info('💥 Sending FULL state sync:', graph.getAllNodes().length, 'nodes')
          await safeSend([{ type: 'fullStateSync', graphData: graph.serialize(), timestamp: globalTimestamp }])
          return
        }
        const delta = oplog.getDelta(ts, hybridClock.compare)
        if (!delta.length) return
        const hydrated = delta.map(op => op.type === 'upsert' ? { ...op, value: graph.get(op.id)?.value } : op)
        console.info('🚀 Sending DELTA sync:', hydrated.length, 'ops')
        await safeSend([{ type: 'deltaSync', operations: pako.deflate(encode(hydrated)), timestamp: globalTimestamp }])
      },

      deltaSync({ operations }) {
        const ops = decodeOps(operations)
        if (!Array.isArray(ops)) return
        console.info('📥 deltaSync:', ops.length, 'ops')
        for (const op of ops) { if (op && apply[op.type]) apply[op.type](op) }
      },

      async fullStateSync({ graphData, timestamp: ts }) {
        if (globalTimestamp && ts && hybridClock.compare(globalTimestamp, ts) > 0) return
        let data = graphData
        if (!(data instanceof Uint8Array)) {
          data = data && typeof data === 'object' ? new Uint8Array(Object.values(data)) : null
        }
        if (!data) return
        graph.deserialize(data)
        oplog.clear()
        changed = true
        console.info('✅ fullStateSync applied:', graph.getAllNodes().length, 'nodes')
        if (ts) { updateHighest(ts); hybridClock.update(ts) }
      }
    }

    for (const c of changes) { if (apply[c.type]) await apply[c.type](c) }

    if (highest && (!globalTimestamp || hybridClock.compare(highest, globalTimestamp) > 0)) {
      updateGlobalTimestamp(highest)
    }

    if (changed) {
      await Promise.all([scheduleSaveGraph(), scheduleSaveOplog()])
      scheduleEmit()
    }
  }

  // ── Public API ──

  const scheduleSendOps = createDebouncedTask(async () => {
    const ops = pendingOps.splice(0)
    return ops.length ? await safeSend(ops) : false
  }, 16)

  Object.assign(publicApi, {
    use(mw) { if (typeof mw === 'function') messageMiddlewares.push(mw) },

    async put(value, id) {
      const timestamp = hybridClock.now()
      updateGlobalTimestamp(timestamp)
      id ??= crypto.randomUUID()
      graph.upsert(id, value, timestamp)
      oplog.add({ type: 'upsert', id, timestamp })
      scheduleSaveGraph(); scheduleSaveOplog()
      try { pendingOps.push({ type: 'upsert', id, value, timestamp }); scheduleSendOps().catch(() => {}) }
      finally { scheduleEmit() }
      return id
    },

    async get(id) {
      if (typeof id !== 'string') return { result: null }
      const node = graph.get(id)
      if (!node) return { result: null }
      return { result: { ...node, value: deepClone(node.value) } }
    },

    /**
     * Query nodes — full operator support, identical to browser GenosDB.
     * Supports: $eq, $ne, $gt, $gte, $lt, $lte, $in, $between, $exists,
     * $startsWith, $endsWith, $contains, $text, $like, $regex,
     * $and, $or, $not, $edge, $limit, $after, $before, field sorting.
     * @param  {...any} args - Options object and/or callback for realtime
     * @returns {{ results: Array, unsubscribe?: Function }}
     */
    map(...args) {
      const defaults = { realtime: false, query: {}, field: null, order: 'asc', $limit: null, $after: null, $before: null }
      let options = { ...defaults }, callback = null, explicitRealtime = false

      args.forEach(arg =>
        typeof arg === 'function'
          ? (callback = arg)
          : arg && typeof arg === 'object' && ((explicitRealtime = explicitRealtime || 'realtime' in arg), Object.assign(options, arg))
      )

      callback && !explicitRealtime && (options.realtime = true)

      let currentResults = processNodes(graph.nodes, options)
      let handler = null

      if (callback) {
        currentResults.forEach(n => callback({ id: n.id, value: n.value, edges: n.edges, timestamp: n.timestamp, action: 'initial' }))

        if (options.realtime) {
          const nodeSig = n => `${n.id}:${n.timestamp?.physical ?? 0}:${n.timestamp?.logical ?? 0}:${(n.edges ?? []).join(',')}`

          handler = (newNodes) => {
            const newResults = processNodes(newNodes, options)
            const oldMap = new Map(currentResults.map(n => [n.id, n]))
            const newMap = new Map(newResults.map(n => [n.id, n]))

            if (newResults.length !== currentResults.length || !newResults.map(nodeSig).every((s, i) => s === currentResults.map(nodeSig)[i])) {
              for (const [id, node] of newMap) {
                const old = oldMap.get(id)
                if (!old) callback({ id, value: node.value, edges: node.edges, timestamp: node.timestamp, action: 'added' })
                else if (nodeSig(node) !== nodeSig(old)) callback({ id, value: node.value, edges: node.edges, timestamp: node.timestamp, action: 'updated' })
              }
              for (const [id, node] of oldMap) {
                if (!newMap.has(id)) callback({ id, value: null, edges: node.edges, timestamp: node.timestamp, action: 'removed' })
              }
              currentResults = newResults
            }
          }

          eventListeners.push(handler)
        }
      }

      return {
        results: currentResults,
        ...(options.realtime && callback && handler && {
          unsubscribe: () => { const i = eventListeners.indexOf(handler); if (i >= 0) eventListeners.splice(i, 1) }
        })
      }
    },

    async link(sourceId, targetId) {
      if (!graph.nodes[sourceId] || !graph.nodes[targetId]) return
      const timestamp = hybridClock.now()
      graph.link(sourceId, targetId, timestamp)
      oplog.add({ type: 'link', sourceId, targetId, timestamp })
      scheduleSaveGraph(); scheduleSaveOplog()
      updateGlobalTimestamp(timestamp)
      try { pendingOps.push({ type: 'link', sourceId, targetId, timestamp }); scheduleSendOps().catch(() => {}) }
      finally { scheduleEmit() }
    },

    async remove(id) {
      const node = graph.get(id)
      if (!node) return
      const timestamp = hybridClock.now()
      delete graph.nodes[id]
      Object.values(graph.nodes).forEach(n => { n.edges = (n.edges ?? []).filter(e => e !== id) })
      oplog.add({ type: 'remove', id, timestamp })
      scheduleSaveGraph(); scheduleSaveOplog()
      updateGlobalTimestamp(timestamp)
      try { pendingOps.push({ type: 'remove', id, value: node.value, timestamp }); scheduleSendOps().catch(() => {}) }
      finally { scheduleEmit() }
    },

    async clear() {
      graph.nodes = {}
      oplog.clear()
      storage.del('graph'); storage.del('oplog')
      emit()
    },

    /** Subscribe to graph changes */
    on(fn) { eventListeners.push(fn); return () => { const i = eventListeners.indexOf(fn); if (i >= 0) eventListeners.splice(i, 1) } },

    close() { storage.close() }
  })

  // ── Networking (GenosRTC) ──

  try {
    const key = `graph-sync-room-${name}`
    const roomConfig = {
      appId: '1234',
      ...(password && { password }),
      ...(relayUrls && { relayUrls }),
      ...(turnConfig && { turnConfig }),
      rtcPolyfill: RTCPeerConnection
    }

    syncRoom = join(roomConfig, key)
    syncChannel = syncRoom.channel('syncGraph')
    publicApi.room = syncRoom

    syncRoom.on('peer:join', async (peerId) => {
      console.info('⚡ Peer connected:', peerId)
      await safeSend([{ type: 'sync', timestamp: globalTimestamp }])
    })

    syncRoom.on('peer:leave', (peerId) => console.info('⚡ Peer disconnected:', peerId))

    syncChannel.on('message', async (msg) => {
      let ops
      try {
        ops = msg instanceof Uint8Array || msg instanceof ArrayBuffer
          ? (() => { const d = decode(msg); return Array.isArray(d) ? d : [d] })()
          : Array.isArray(msg) ? msg : [msg]
      } catch (e) { return console.error('❌ decode failed:', e) }

      const prevStates = new Map(
        [...new Set(ops.flatMap(op => ['id', 'sourceId', 'targetId'].map(f => op?.[f]).filter(Boolean)))]
          .map(id => graph.get(id) ? [id, deepClone(graph.get(id))] : null).filter(Boolean)
      )

      for (const mw of messageMiddlewares) {
        try { ops = await mw(ops, prevStates); if (!ops?.length) return }
        catch (e) { console.error('❌ Middleware error:', e); return }
      }

      await receiveChanges(ops)
    })

    console.info('✅ GenosRTC sync enabled')
  } catch (err) {
    console.warn('⚠️ GenosRTC not available:', err.message)
  }

  // ── Init: Load from SQLite ──

  loadGraph()
  loadTimestamp()
  loadOplog()

  // Expose internals for advanced use
  Object.defineProperties(publicApi, {
    syncChannel: { get: () => syncChannel },
    hybridClock: { get: () => hybridClock },
    graph: { get: () => ({ getAllNodes: () => graph.getAllNodes(), get: (id) => graph.get(id) }) }
  })

  console.info(`✅ GDBServer [${name}] ready (bun:sqlite)`)
  return publicApi
}

// Auto-start when run directly
if (import.meta.main) {
  gdbServer().catch(e => { console.error('❌ Fatal:', e.message); process.exit(1) })
}
