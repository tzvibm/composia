# Composia

A backend orchestration engine that assembles hierarchical data structures (trees) dynamically using an **Instruction Matrix**. It stitches atomic units of data based on caller authority (Namespaces).

## Tech Stack

- **Runtime:** Node.js + Fastify
- **Storage:** LMDB (embedded key-value store) via Rust native module (NAPI-RS)
- **Validation:** Zod schemas
- **Docs:** OpenAPI/Swagger at `/docs`

## Quick Start

```bash
npm install
npm run build      # Build Rust native module
npm start          # Start server on PORT=3000
npm run dev        # Development mode
npm test           # Run tests
```

## Architecture

```
API Layer (Fastify)  →  Service Layer  →  DAL  →  Rust Engine (LMDB)
    routes/              services/        dal/       src/lib.rs
    controllers/
```

### Databases (LMDB)

- **units**: Key-value store (`id` → JSON payload with label)
- **matrix**: Instruction relationships (`namespace:source:verb:target:order` → `{order, verb_value}`)
- **namespaces**: Namespace registry (`namespace_id` → metadata)

## Core Concepts

### Units

Atomic data containers with a 32-character hex ID, a label, and a JSON payload.

### Namespaces

User-provided unique identifiers for hierarchies. When resolving, the caller specifies which namespace to query. Access control is structural—different namespaces see different tree compositions from the same underlying units.

### Instruction Matrix

Defines relationships between units via verbs:

| Verb | Purpose | verb_value |
|------|---------|------------|
| `UNIT` | Parent-child containment | — |
| `HIDE` | Suppress unit from resolution | — |
| `REPLACE` | Substitute one unit for another | replacement unit ID |
| `OVERLAY` | Merge additional payload data | overlay unit ID |
| `MOUNT` | Attach a namespace to a unit | namespace ID |

### Mount Namespaces

A unit with `MOUNT` verb carries its own namespace. During resolution, both the request namespace and mount namespace are checked, enabling cross-namespace composition.

## Resolution Cycle

The resolver executes an 8-step cycle for each unit:

1. **Mount Check** — Detect if unit has a `MOUNT` verb (carries its own namespace)
2. **Hide Check** — Check both namespaces for `HIDE` instruction
3. **Replacement** — Apply `REPLACE` verbs (mount namespace first, then request namespace)
4. **Overlay Retrieval** — Gather `OVERLAY` instructions from both namespaces
5. **Merge** — Apply overlays in order (mount overlays first, request overlays override)
6. **Structure Update** — Build final unit object with merged payload
7. **Width Limitation** — Get child members respecting width limits and offset
8. **Recurse** — Process children until depth limit reached

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/units` | Create units |
| GET | `/units/:id` | Get unit by ID |
| PATCH | `/units` | Update units |
| DELETE | `/units` | Delete units |
| POST | `/namespaces` | Register namespace |
| GET | `/namespaces` | List namespaces |
| GET | `/namespaces/:id` | Get namespace |
| DELETE | `/namespaces/:id` | Delete namespace |
| POST | `/matrix/link` | Create matrix entry |
| DELETE | `/matrix/unlink` | Delete matrix entry |
| GET | `/matrix/targets` | Get targets for source/verb |
| POST | `/resolve` | Resolve hierarchy |
| GET | `/health` | Health check |

Full API documentation available at `http://localhost:3000/docs` when running.

## System Invariants

Environment-level limits prevent runaway recursion:

| Variable | Default | Purpose |
|----------|---------|---------|
| `MAX_DEPTH` | 100 | Maximum recursion depth |
| `MAX_WIDTH` | 10 | Maximum children per node |
| `MAX_OVERLAYS` | 5 | Maximum overlay merges per unit |

## Example: Resolution Request

```bash
curl -X POST http://localhost:3000/resolve \
  -H "Content-Type: application/json" \
  -d '{
    "namespace": "admin_view",
    "unit_id": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
    "depth": 3,
    "width": 10,
    "include_ops": true
  }'
```

Response includes the resolved hierarchy tree and optionally an operations log showing each step of the resolution cycle.