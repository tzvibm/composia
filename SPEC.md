# Composia System Specification

## Migration: LMDB/Rust → RocksDB/JavaScript

This document specifies the complete Composia system after migration from Rust+LMDB to pure JavaScript+RocksDB. The instruction matrix model, resolution algorithm, and API surface remain identical. Only the storage engine and language binding change.

---

## 1. System Overview

Composia is a backend orchestration engine that assembles hierarchical data structures (trees) dynamically using an **Instruction Matrix**. It stitches atomic units of data based on caller authority (Namespaces).

**Stack:** Node.js + Fastify + RocksDB (via `rocksdb` npm package)

```
API Layer (Fastify)  →  Service Layer  →  DAL (Engine)  →  RocksDB
    routes/              services/        dal/engine.js      (embedded)
    controllers/
```

### What Changes
| Component | Before | After |
|-----------|--------|-------|
| Storage engine | LMDB (memory-mapped B+tree) | RocksDB (LSM-tree, concurrent writes) |
| Engine binding | Rust via NAPI-RS (`src/lib.rs`) | Pure JavaScript (`src/dal/engine.js`) |
| Engine API | Synchronous | Asynchronous (async/await) |
| Build step | `napi build --release` | None (prebuilt RocksDB binaries) |
| Write concurrency | Single-writer lock | Concurrent writers |

### What Does NOT Change
- API endpoints (routes, controllers, request/response schemas)
- Zod validation models
- Resolution algorithm (8-step cycle)
- Matrix key format and semantics
- All 5 verb types (UNIT, HIDE, REPLACE, OVERLAY, MOUNT)
- Namespace, unit, and matrix invariants
- Test assertions and expected behavior

---

## 2. Storage Architecture

### 2.1 Column Families

RocksDB column families replace LMDB's named databases. Three column families:

| Column Family | Key | Value | Purpose |
|---------------|-----|-------|---------|
| `units` | Unit ID (32-char hex) | JSON string `{id, label, payload, created_at}` | Unit payload storage |
| `matrix` | `{namespace}:{source}:{verb}:{target}:{order:010.0}` | JSON string `{order, verb_value}` | Instruction relationships |
| `namespaces` | Namespace ID (1-64 chars, `[a-z0-9_]+`) | JSON string `{id, metadata}` | Namespace registry |

### 2.2 Matrix Key Format

```
{namespace}:{source}:{verb}:{target}:{padded_order}
```

- **namespace**: 1-64 chars, lowercase alphanumeric + underscores
- **source**: 32-char hex unit ID
- **verb**: One of `UNIT`, `HIDE`, `REPLACE`, `OVERLAY`, `MOUNT`
- **target**: 32-char hex unit ID
- **padded_order**: `order` formatted as zero-padded float (`%010.1f`), e.g., `0000000001.0`

Padding enables lexicographic sorting to match numeric order. Prefix iteration on `{namespace}:{source}:{verb}:` retrieves all targets sorted by order.

### 2.3 RocksDB Configuration

```javascript
{
  createIfMissing: true,
  errorIfExists: false,
  compression: 'snappy',        // default, good balance
  writeBufferSize: 64 * 1024 * 1024,  // 64MB write buffer
  maxOpenFiles: 1000,
  // Column families created on open: ['default', 'units', 'matrix', 'namespaces']
}
```

### 2.4 Concurrency Model

- **Reads**: Lock-free concurrent reads via RocksDB snapshots
- **Writes**: Concurrent writers supported (LSM-tree architecture)
- **Batch writes**: `put_units`, `update_units`, `delete_units` use RocksDB `batch()` for atomicity
- **No single-writer bottleneck** (primary motivation for migration)

---

## 3. Engine API (`src/dal/engine.js`)

The engine is a JavaScript class exporting the same 15 methods as the Rust engine. All methods are now **async**.

### 3.1 Constructor

```javascript
class ComposiaEngine {
  constructor(dbPath: string)
}
```

- Opens RocksDB at `dbPath` with three column families
- Creates the directory if it doesn't exist
- Exported as a singleton from `src/dal/db.js`

### 3.2 Namespace Operations

#### `async register_namespace(namespace_id: string, metadata: object): void`
- Checks if `namespace_id` exists in `namespaces` column family
- If exists: throws `Error('Namespace already exists')`
- If not: stores `{id: namespace_id, metadata}` as JSON value

#### `async namespace_exists(namespace_id: string): boolean`
- Returns `true` if key exists in `namespaces` column family

#### `async get_namespace(namespace_id: string): object | null`
- Returns parsed JSON metadata object, or `null` if not found

#### `async list_namespaces(): Array<{id, metadata}>`
- Full iteration over `namespaces` column family
- Returns array of all namespace objects

#### `async delete_namespace(namespace_id: string): boolean`
- Deletes key from `namespaces` column family
- Returns `true` if existed and was deleted, `false` if not found

### 3.3 Unit Operations

#### `async put_units(units: Array<{id, label?, payload?}>): Array<object>`
- Batch write to `units` column family
- Each unit keyed by `unit.id`
- Value: JSON string of full unit object
- Returns array of stored unit objects

#### `async get_units(ids: Array<string>): Array<object>`
- Multi-get from `units` column family
- Skips IDs that don't exist (no error)
- Returns array of found unit objects

#### `async update_units(updates: Array<{id, ...fields}>): Array<object>`
- For each update: fetch existing unit, shallow merge new fields (except `id`), store result
- Uses batch write for atomicity
- Returns array of updated unit objects

#### `async delete_units(ids: Array<string>): Array<string>`
- Batch delete from `units` column family
- Returns array of IDs that were actually deleted

### 3.4 Matrix Operations

#### `async link_units(namespace, source, verb, target, order, verb_value?): void`
- Validates namespace exists (throws if not)
- Constructs key: `{namespace}:{source}:{verb}:{target}:{padded_order}`
- Stores value: `{order, verb_value}` as JSON
- No uniqueness enforcement at engine level (service layer handles this for UNIT/HIDE/REPLACE)

#### `async unlink_units(namespace, source, verb, target): boolean`
- Prefix: `{namespace}:{source}:{verb}:{target}:`
- Iterates all keys matching prefix, deletes each
- Returns `true` if any deleted, `false` if none found

#### `async has_matrix_entry(namespace, source, verb, target): boolean`
- Prefix: `{namespace}:{source}:{verb}:{target}:`
- Returns `true` if at least one key exists with this prefix

#### `async get_matrix_entry(namespace, source, verb, target): object | null`
- Prefix: `{namespace}:{source}:{verb}:{target}:`
- Returns first matching entry's value `{order, verb_value}`, or `null`
- "First" = lowest order (lexicographic first due to padding)

#### `async get_targets(namespace, source, verb): Array<{target, order, verb_value}>`
- Prefix: `{namespace}:{source}:{verb}:`
- Iterates all matching keys
- Parses target and order from key, verb_value from value
- Returns array sorted by order (lexicographic = numeric due to padding)

#### `async get_matrix_segment(prefix: string): Array<object>`
- Iterates all keys in `matrix` column family matching arbitrary prefix
- Parses key components: `{namespace, source, verb, target, order}`
- Returns array of fully parsed entries (for admin/debug)

### 3.5 Database Operations

#### `async clear_db(): void`
- Clears all three column families
- Used in test setup/teardown

---

## 4. DAL Initialization (`src/dal/db.js`)

```javascript
import { ComposiaEngine } from './engine.js';

const dbPath = resolve(process.env.DB_PATH || './data/composia.db');
export const engine = new ComposiaEngine(dbPath);

export const cleanDb = async () => { await engine.clear_db(); };
export const closeDb = async () => { await engine.close(); };
```

Key differences from current:
- `cleanDb` and `closeDb` are now async
- File extension changes from `.mdb` to `.db` (RocksDB directory)
- No native binary loading (`require('composia_native.node')` removed)
- `close()` method added — RocksDB requires explicit close unlike LMDB

---

## 5. Service Layer Changes

All service methods become **async** (they already return from async controller handlers). The function signatures and validation logic remain identical.

### 5.1 Units Service (`src/services/units.service.js`)

| Method | Change |
|--------|--------|
| `createUnits(input)` | Add `await` to `engine.put_units()` |
| `getUnitsByIds(input)` | Add `await` to `engine.get_units()` |
| `updateUnits(input)` | Add `await` to `engine.update_units()` |
| `updatePayloads(input)` | Add `await` to `engine.update_units()` |
| `deleteUnits(input)` | Add `await` to `engine.delete_units()` |

### 5.2 Namespace Service (`src/services/namespace.service.js`)

| Method | Change |
|--------|--------|
| `registerNamespace(input)` | Add `await` to `engine.register_namespace()` |
| `namespaceExists(id)` | Add `await` to `engine.namespace_exists()` |
| `getNamespace(id)` | Add `await` to `engine.get_namespace()` |
| `listNamespaces()` | Add `await` to `engine.list_namespaces()` |
| `deleteNamespace(id)` | Add `await` to `engine.delete_namespace()` |

### 5.3 Matrix Service (`src/services/matrix.service.js`)

| Method | Change |
|--------|--------|
| `linkUnits(input)` | Add `await` to `engine.link_units()` |
| `unlinkUnits(input)` | Add `await` to `engine.unlink_units()` |
| `hasMatrixEntry(ns, src, verb, tgt)` | Add `await` to `engine.has_matrix_entry()` |
| `getMatrixEntry(ns, src, verb, tgt)` | Add `await` to `engine.get_matrix_entry()` |
| `getTargets(ns, src, verb)` | Add `await` to `engine.get_targets()` |
| `getMatrixSegment(prefix)` | Add `await` to `engine.get_matrix_segment()` |

### 5.4 Resolution Service (`src/services/resolution.service.js`)

The 8-step `resolveUnitCycle` function becomes `async`. Every engine call within it gets `await`. The recursive call in Step 8 uses `await` (sequential per child — order matters).

No logic changes. The algorithm is identical.

---

## 6. Resolution Algorithm (Unchanged)

### 6.1 Entry Point

```
POST /resolve
{
  namespace: string,      // required
  unit_id: string,        // required, 32-char hex
  depth: number,          // 0-10, default 2
  width: number,          // 1-100, default 10
  offset: number,         // >= 0, default 0 (first level only)
  include_ops: boolean    // default false
}
```

### 6.2 Per-Cycle Steps

**Input per cycle:** `(namespace, sourceId, targetId, currentDepth, options)`

#### Step 1: Mount Check
- Query: `get_matrix_entry(namespace, sourceId, 'MOUNT', targetId)`
- If found: `mountNs = entry.verb_value`
- If not: `mountNs = null`

#### Step 2: Hide Check
- Query: `has_matrix_entry(namespace, sourceId, 'HIDE', targetId)`
- If mounted, also: `has_matrix_entry(mountNs, sourceId, 'HIDE', targetId)`
- If either is true: return `null` (unit pruned from output)

#### Step 3: Replacement
- `effectiveId = targetId`
- If mounted: check `get_matrix_entry(mountNs, sourceId, 'REPLACE', targetId)`
  - If found: `effectiveId = entry.verb_value`
- Check `get_matrix_entry(namespace, sourceId, 'REPLACE', effectiveId)`
  - If found: `effectiveId = entry.verb_value`
- Request namespace REPLACE always overrides mount namespace REPLACE

#### Step 4: Overlay Retrieval
- Query: `get_targets(namespace, sourceId, 'OVERLAY')` → filter where `target === targetId`
- If mounted: `get_targets(mountNs, sourceId, 'OVERLAY')` → filter where `target === targetId`
- Fetch base unit: `get_units([effectiveId])`
- Fetch all overlay units by their `verb_value` IDs
- Cap at `MAX_OVERLAYS`

#### Step 5: Merge Priority
- Start with base unit's payload
- If mounted:
  1. Deep merge mount namespace overlays (ascending order, highest wins)
  2. Deep merge request namespace overlays (ascending order, overrides mount)
- If not mounted: only request namespace overlays

#### Step 6: Structure Update
```javascript
{
  id: effectiveId,
  original_id: targetId,  // only if effectiveId !== targetId (replaced)
  label: baseUnit.label,
  payload: mergedPayload,
  children: []
}
```

#### Step 7: Width Limitation
- If `currentDepth >= maxDepth`: stop recursion, return unit with empty children
- Query: `get_targets(namespace, effectiveId, 'UNIT')`
- If mounted: also `get_targets(mountNs, effectiveId, 'UNIT')`, dedupe by target
- If first level and offset > 0: filter `order > offset`
- Slice to `maxWidth`

#### Step 8: Recurse
- For each member from Step 7:
  - `await resolveUnitCycle(namespace, effectiveId, member.target, currentDepth + 1, options)`
  - If result is not null: push to `children`

### 6.3 Deep Merge Function

```javascript
function deepMerge(source, target) {
  const result = { ...source };
  for (const key of Object.keys(target)) {
    if (isPlainObject(target[key]) && isPlainObject(source[key])) {
      result[key] = deepMerge(source[key], target[key]);
    } else {
      result[key] = target[key];
    }
  }
  return result;
}
```

---

## 7. Data Models (Unchanged)

### 7.1 Unit

```javascript
{
  id: string,          // 32-char lowercase hex, ^[a-f0-9]{32}$
  label: string,       // min 1 char
  payload: object,     // arbitrary JSON (Record<string, any>)
  created_at: any      // timestamp, auto-managed
}
```

### 7.2 Namespace

```javascript
{
  id: string,          // 1-64 chars, ^[a-z0-9_]+$
  metadata: object     // arbitrary JSON, default {}
}
```

### 7.3 Matrix Entry

```javascript
{
  namespace: string,   // valid namespace ID
  source: string,      // 32-char hex unit ID
  verb: enum,          // 'UNIT' | 'HIDE' | 'REPLACE' | 'OVERLAY' | 'MOUNT'
  target: string,      // 32-char hex unit ID
  order: number,       // default 0
  verb_value: string?  // required for REPLACE, OVERLAY, MOUNT
}
```

### 7.4 Verb Semantics

| Verb | `verb_value` | Cardinality per ns:src:tgt | Effect |
|------|-------------|---------------------------|--------|
| `UNIT` | null | 1 | Declares containment (parent→child) |
| `HIDE` | null | 1 | Suppresses unit from resolution |
| `REPLACE` | replacement unit ID | 1 | Substitutes unit payload (tracks `original_id`) |
| `OVERLAY` | overlay unit ID | many (ordered) | Merges overlay payload into unit |
| `MOUNT` | namespace ID | 1 | Embeds foreign namespace context |

---

## 8. API Endpoints (Unchanged)

### 8.1 Units

| Method | Path | Body/Query | Response |
|--------|------|-----------|----------|
| `POST` | `/units` | `[{label, payload?}]` | `201` `[{id, label, payload, created_at}]` |
| `GET` | `/units` | `?ids=id1,id2` | `200` `[{id, label, payload}]` |
| `PATCH` | `/units` | `[{id, label?}]` | `200` `[{id, label, payload}]` |
| `PATCH` | `/units/payload` | `[{id, payload}]` | `200` `[{id, label, payload}]` |
| `DELETE` | `/units` | `{ids: [id1, id2]}` | `200` `{deleted: [...], count}` |

### 8.2 Namespaces

| Method | Path | Body/Params | Response |
|--------|------|------------|----------|
| `POST` | `/namespaces` | `{id, metadata?}` | `201` `{id, metadata}` |
| `GET` | `/namespaces` | — | `200` `[{id, metadata}]` |
| `GET` | `/namespaces/:id` | `:id` param | `200` `{id, metadata}` / `404` |
| `DELETE` | `/namespaces/:id` | `:id` param | `204` / `404` |

### 8.3 Matrix

| Method | Path | Body/Query | Response |
|--------|------|-----------|----------|
| `POST` | `/matrix/link` | `{namespace, source, verb, target, order, verb_value?}` | `201` |
| `DELETE` | `/matrix/link` | `{namespace, source, verb, target}` | `204` / `404` |
| `GET` | `/matrix/targets` | `?namespace&source&verb` | `200` `[{target, order, verb_value}]` |
| `GET` | `/matrix/entry` | `?namespace&source&verb&target` | `200` `{order, verb_value}` / `404` |
| `GET` | `/matrix/exists` | `?namespace&source&verb&target` | `200` `{exists: bool}` |
| `GET` | `/matrix/segment` | `?prefix` | `200` `[{namespace, source, verb, target, order, verb_value}]` |

### 8.4 Resolution

| Method | Path | Body | Response |
|--------|------|------|----------|
| `POST` | `/resolve` | `{namespace, unit_id, depth?, width?, offset?, include_ops?}` | `200` `{hierarchy, operations?}` |

### 8.5 System

| Method | Path | Response |
|--------|------|----------|
| `GET` | `/health` | `200` `{status: 'ok', timestamp}` |
| `GET` | `/docs` | Swagger UI (non-test only) |

---

## 9. Error Handling (Unchanged)

| Condition | HTTP | Error |
|-----------|------|-------|
| Zod validation failure | `400` | `{error: 'Validation Failed', details: [...]}` |
| Namespace not found | `404` | `{error: "Namespace 'x' not found"}` |
| Unit not found | `404` | `{error: "Unit 'x' not found"}` |
| Matrix entry not found | `404` | `{error: "Matrix entry not found"}` |
| Namespace already exists | `409` | `{error: "Namespace 'x' already exists"}` |
| Internal error | `500` | `{error: "Internal Server Error"}` |

---

## 10. System Invariants (Unchanged)

### Uniqueness
- One entry per `namespace:source:target` for verbs: `UNIT`, `REPLACE`, `HIDE`
- Multiple entries per `namespace:source:target` for verb: `OVERLAY` (ordered)
- Namespace IDs globally unique

### Mount Constraints
- A mounted unit cannot be replaced within the namespace it was mounted in
- Only non-mounted units can be mounted via `verb=UNIT`

### Limits (from environment)
- `MAX_WIDTH` — max children resolved per level (default 10)
- `MAX_DEPTH` — max recursion depth (default 2)
- `MAX_OVERLAYS` — max overlays merged per unit (default 5)

---

## 11. Configuration

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `DB_PATH` | `./data/composia.db` | RocksDB directory path |
| `PORT` | `3000` | HTTP server port |
| `NODE_ENV` | — | `production` / `development` / `test` |
| `MAX_DEPTH` | `10` | System max recursion depth |
| `MAX_WIDTH` | `10` | System max children per level |
| `MAX_OVERLAYS` | `5` | System max overlays per unit |

### package.json Changes

```jsonc
{
  "type": "module",
  // REMOVED: "napi" config block
  "scripts": {
    // REMOVED: "build", "build:debug" (no Rust compilation)
    "start": "NODE_ENV=production node src/app.js",
    "dev": "NODE_ENV=development node src/app.js",
    "test": "NODE_ENV=test vitest run --no-file-parallelism",
    "test:watch": "NODE_ENV=test vitest --no-file-parallelism"
  },
  "dependencies": {
    "rocksdb": "^3.13.0",          // NEW: RocksDB binding
    "fastify": "^5.0.0",
    "@fastify/cors": "^10.0.0",
    "@fastify/swagger": "^9.6.1",
    "@fastify/swagger-ui": "^5.2.4",
    "dotenv": "^16.4.5",
    "zod": "^3.23.8"
    // REMOVED: lodash (deepMerge implemented inline)
  },
  "devDependencies": {
    "vitest": "^2.1.0"
    // REMOVED: @napi-rs/cli
  }
}
```

---

## 12. File Structure (After Migration)

```
composia/
├── src/
│   ├── app.js                         # Fastify app (unchanged)
│   ├── dal/
│   │   ├── engine.js                  # NEW: ComposiaEngine class (RocksDB)
│   │   └── db.js                      # Singleton init (updated: async, no native binary)
│   ├── services/
│   │   ├── units.service.js           # Updated: async engine calls
│   │   ├── namespace.service.js       # Updated: async engine calls
│   │   ├── matrix.service.js          # Updated: async engine calls
│   │   └── resolution.service.js      # Updated: async engine calls
│   ├── controllers/                   # Unchanged (already async)
│   │   ├── units.controller.js
│   │   ├── namespace.controller.js
│   │   ├── matrix.controller.js
│   │   └── resolution.controller.js
│   ├── routes/                        # Unchanged
│   │   ├── units.routes.js
│   │   ├── namespace.routes.js
│   │   ├── matrix.routes.js
│   │   └── resolution.routes.js
│   ├── models/                        # Unchanged
│   │   ├── unit.model.js
│   │   ├── namespace.model.js
│   │   ├── matrix.model.js
│   │   └── resolution.model.js
│   └── utils/
│       └── id.js                      # Unchanged
├── tests/                             # Updated: async engine calls in setup/teardown
│   ├── engine.test.js
│   ├── resolution.test.js
│   ├── api.test.js
│   └── unit/
├── data/                              # RocksDB directory (was .mdb file)
│   └── composia.db/
├── package.json                       # Updated: rocksdb dep, no napi
├── SPEC.md                            # This file
└── CLAUDE.md                          # Updated: remove Rust references
```

### Files Removed
- `src/lib.rs` — Rust engine (replaced by `src/dal/engine.js`)
- `Cargo.toml` — Rust manifest
- `build.rs` — Rust build script (if any)
- `composia_native.node` — compiled native binary

### Files Added
- `src/dal/engine.js` — JavaScript RocksDB engine

---

## 13. RocksDB Prefix Iteration Pattern

The core operation that makes this migration work is prefix iteration. RocksDB supports this natively via iterators with `gte`/`lte` bounds:

```javascript
// Equivalent of LMDB prefix scan
async prefixScan(columnFamily, prefix) {
  const results = [];
  const iterator = columnFamily.iterator({
    gte: prefix,
    lte: prefix + '\xFF',   // all keys starting with prefix
  });

  for await (const [key, value] of iterator) {
    results.push({ key: key.toString(), value: JSON.parse(value.toString()) });
  }

  return results;
}
```

This replaces the Rust `iter_range` calls used for:
- `get_targets()` — prefix `{ns}:{src}:{verb}:`
- `has_matrix_entry()` — prefix `{ns}:{src}:{verb}:{tgt}:`
- `get_matrix_entry()` — prefix `{ns}:{src}:{verb}:{tgt}:`
- `unlink_units()` — prefix `{ns}:{src}:{verb}:{tgt}:`
- `get_matrix_segment()` — arbitrary prefix

---

## 14. Migration Checklist

1. **Install RocksDB**: `npm install rocksdb`
2. **Implement `src/dal/engine.js`**: ComposiaEngine class with all 15 methods
3. **Update `src/dal/db.js`**: Async initialization, remove native binary loading
4. **Update services**: Add `async/await` to all engine calls
5. **Update `src/app.js`**: Ensure engine is ready before accepting requests (async init)
6. **Update tests**: Add `async/await` to engine calls in setup/teardown
7. **Remove Rust artifacts**: `src/lib.rs`, `Cargo.toml`, napi config
8. **Update `package.json`**: Remove napi deps, add rocksdb, remove build scripts
9. **Update `CLAUDE.md`**: Reflect new stack
10. **Run full test suite**: All existing tests must pass
