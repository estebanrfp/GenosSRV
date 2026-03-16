# GenosSRV

High-performance distributed graph database node powered by **Bun + SQLite**. Peer-compatible with browser [GenosDB](https://github.com/nicholasgasior/gdb) via P2P sync (GenosRTC/WebRTC).

## What it does

GenosSRV acts as a persistent superpeer for GenosDB — it joins the same P2P room as browser instances, syncs data bidirectionally via CRDT, and stores everything in SQLite with WAL mode for crash-safe durability.

```
Browser (GenosDB/OPFS) ←──P2P──→ GenosSRV (SQLite) ←──P2P──→ Browser (GenosDB/OPFS)
```

- **Full query engine** — `map()` with 15+ operators (`$eq`, `$gt`, `$in`, `$contains`, `$regex`, `$edge`, etc.), identical to browser GenosDB
- **Realtime subscriptions** — `map({ realtime: true }, callback)` for reactive queries
- **CRDT sync** — HybridClock + conflict resolution + delta/full sync via oplog
- **SQLite WAL** — ACID-compliant, no data loss on crash
- **Zero HTTP** — pure P2P, no Express, no REST

## Install

```bash
pnpm install
```

## Usage

### CLI

```bash
# Join a room (matches browser GenosDB room name)
bun index.js myRoomName

# Default room name: "default"
bun index.js

# Environment variables
GDB_ROOM=myRoom GDB_DB_PATH=./mydata.sqlite bun index.js
```

### As a module

```js
import { gdbServer } from './index.js'

const db = await gdbServer('myRoom', {
  password: 'optional-encryption',    // P2P encryption
  relayUrls: ['wss://...'],           // Custom Nostr relays
  saveDelay: 200,                     // Debounce interval (ms)
  oplogSize: 1000                     // Max oplog entries
}, './data.sqlite')

// Write
const id = await db.put({ text: 'hello', ts: Date.now() })
const id2 = await db.put({ text: 'world' }, 'custom-id')

// Read
const { result } = await db.get(id)

// Query (full operator support)
const { results } = db.map({ query: { type: 'message', ts: { $gte: Date.now() - 86400000 } } })

// Realtime subscription
const { unsubscribe } = db.map({ query: { type: 'task' }, realtime: true }, (node) => {
  console.log(node.action, node.id, node.value) // 'added' | 'updated' | 'removed'
})

// Graph relationships
await db.link(sourceId, targetId)

// Delete
await db.remove(id)

// Middleware (intercept incoming sync messages)
db.use(async (ops, prevStates) => {
  // filter, transform, or reject ops
  return ops
})

// Lifecycle
db.on((snapshot) => console.log('graph changed'))
db.close()
```

## Query Operators

Identical to browser GenosDB:

| Operator | Example |
|----------|---------|
| `$eq` | `{ status: { $eq: 'active' } }` |
| `$ne` | `{ type: { $ne: 'draft' } }` |
| `$gt`, `$gte`, `$lt`, `$lte` | `{ score: { $gte: 90 } }` |
| `$in` | `{ role: { $in: ['admin', 'mod'] } }` |
| `$between` | `{ ts: { $between: [start, end] } }` |
| `$exists` | `{ email: { $exists: true } }` |
| `$startsWith`, `$endsWith` | `{ name: { $startsWith: 'geo' } }` |
| `$contains`, `$text` | `{ bio: { $contains: 'developer' } }` |
| `$regex` | `{ code: { $regex: '^[A-Z]{3}' } }` |
| `$and`, `$or`, `$not` | `{ $or: [{ a: 1 }, { b: 2 }] }` |
| `$edge` | `{ $edge: { type: 'concept' } }` |
| `$limit`, `$after`, `$before` | Pagination |

## Architecture

```
┌─────────────────────────────────────┐
│ GenosSRV                            │
│                                     │
│  index.js          → Core (CRUD, sync, graph, queries)
│  Operators.js      → Query engine (15+ operators)
│  HybridClock.js    → Causal ordering (HLC)
│  conflictResolver.js → LWW conflict resolution
│  genosrtc.min.js   → P2P networking (WebRTC + Nostr)
│  genosrtc-bun.js   → Bun runtime compatibility wrapper
│                                     │
│  SQLite (WAL)      → Persistent storage
│  GenosRTC          → Peer discovery + data channels
└─────────────────────────────────────┘
```

## Requirements

- **Bun** >= 1.0.0
- **pnpm** for package management

## Author

Esteban Fuster Pozzi (@estebanrfp) — Full Stack JavaScript Developer
