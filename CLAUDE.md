# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Composia is a backend orchestration engine that assembles hierarchical data structures (trees) dynamically using an **Instruction Matrix**. It stitches atomic units of data based on caller authority (Namespaces). The system uses LMDB (embedded key-value store) with a Rust native module for performance.

## Commands

```bash
npm run build          # Build Rust native module (release)
npm run build:debug    # Build Rust native module (debug)
npm start              # Build and start production server (PORT=3000)
npm run dev            # Start development server
npm test               # Run all tests (Vitest)
npm run test:watch     # Run tests in watch mode
```

To run a single test file:
```bash
NODE_ENV=test npx vitest run tests/resolution.test.js
```

## Architecture

**Stack:** Node.js + Fastify + Rust (NAPI-RS) + LMDB

```
API Layer (Fastify)  →  Service Layer  →  DAL  →  Rust Engine (LMDB)
    routes/              services/        dal/       src/lib.rs
    controllers/
```

### Core Components

- **Rust Engine** (`src/lib.rs`): NAPI bindings wrapping LMDB with two databases:
  - `units`: key-value store (id → JSON payload)
  - `matrix`: instruction relationships (namespace:source:verb:target → order)

- **Service Layer** (`src/services/units.service.js`): Contains the 6-step composition resolver:
  1. Hide Logic - Check for HIDE instructions
  2. Replacement Logic - Replace with alternative unit
  3. Fetch Base Unit
  4. Apply Overlays - Merge additional data
  5. Recursion - Process children
  6. Inheritance - Fall back to original children if replaced unit has none

- **Models** (`src/models/unit.model.js`): Zod schemas for request validation

### Key Concepts

**Namespaces**: Different authorities see different tree compositions. Admin might see a "Delete" button; User namespace might have it hidden. Same data, different structure.

**Verbs**: Instruction types - `contains` (parent-child), `hide`, `replace`, `overlay`, `points_to`, `metadata`

**Unit IDs**: 32-character lowercase hex (MD5-based)

**Matrix Key Format**: `{namespace}:{source}:{verb}:{target}`

### System Invariants (from .env)

- `MAX_WIDTH=10` - Max children per node
- `MAX_DEPTH=1` - Max recursion levels
- `MAX_NAMESPACE=5` - Max active authorities
- `MAX_OVERLAYS=5` - Max merge operations per unit

## Database

LMDB database stored in `data/composia.mdb`. The Rust engine is initialized as a singleton in `src/dal/db.js`.
