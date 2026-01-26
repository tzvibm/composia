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

- **Rust Engine** (`src/lib.rs`): NAPI bindings wrapping LMDB with three databases:
  - `units`: key-value store (id → JSON payload)
  - `matrix`: instruction relationships (namespace:source:verb:target → order, verb_value)
  - `namespaces`: namespace registry (namespace_id → metadata) for uniqueness enforcement

- **Service Layer** (`src/services/units.service.js`): Contains the composition resolver implementing the resolution sequence below

- **Models** (`src/models/unit.model.js`): Zod schemas for request validation

### Key Concepts

**Namespace**: A user-provided unique identifier for their hierarchy. Each hierarchy created by a user has its own namespace. When traversing/resolving a hierarchy, the user provides the namespace they want to query. Namespaces are registered in the `namespaces` database to enforce uniqueness.

**Mount Namespace**: A unit with verb `MOUNT` carries its own namespace (stored in `verb_value`). When processing mounted units, both the request namespace AND the mount namespace are checked for all operations. This allows embedding units from one namespace context into another.

**Verbs**: Instruction types stored in the matrix:
- `UNIT` - Containment relationship (used for both root and parent-child relationships)
- `HIDE` - Suppress a unit from resolution
- `REPLACE` - Substitute one unit for another (replacement ID in `verb_value`)
- `OVERLAY` - Merge additional payload data (overlay unit ID in `verb_value`)
- `MOUNT` - Attach a namespace to a unit (namespace ID in `verb_value`)

**Unit IDs**: 32-character lowercase hex (MD5-based)

**Matrix Key Format**: `{namespace}:{source}:{verb}:{target}` → `{order, verb_value}`

---

## Resolution Sequence

### Component Steps

1. **Resolution**: Use the (namespace and mount namespace, if available) and the (source unit ID / target unit ID, which are identical for a `UNIT` acting as a root) to resolve the final unit according to logic rules. Verb logic is applied only in the request namespace, except when the unit is a `MOUNT` verb (and thus has its own namespace), while considering `UNIT`, `HIDE`, and `REPLACE` verbs.

2. **Overlay Identification**: Use the (namespace and mount namespace, if available) and the (source unit ID / target unit ID, which are identical for a `UNIT` acting as a root) to resolve the `OVERLAY` instruction_matrix records according to logic rules. These records store the overlay unit ID in the `verb_value` field. Verb logic applies only to the request namespace, or specifically to a `MOUNT` verb's own namespace.

3. **Payload Merge**: Perform a JSON merge of the unit's payload with overlays according to their `order` column in the instruction matrix for each overlay, following the rules established for mounted unit scenarios.

4. **Member Resolution**: Resolve `UNIT` verb records in the instruction_matrix for the namespace and the (source unit ID / target unit ID, which are identical for a `UNIT` acting as a root). If the unit is mounted, retrieve records for the mount namespace as well.

5. **Recursive Order**: Resolve the order of `UNIT` recursive resolution through Step 1 according to the rules for the namespace and, in the case of a mount, the mount namespace.

6. **Output**: Return a hierarchical JSON structure of final resolved units with their resolved payloads. Additionally, return the sequence of operations—including verb discovery and the application of logic—used to generate the final hierarchy of units and payloads.

### Request Types

- **Non-Pagination Input**: For an origination unit, the input is a namespace, a source unit ID (identical to target), and a target unit ID (identical to source)
- **Pagination Input**: Input consists of an offset order number, namespace, and instruction matrix ID → proceeds directly to Step 6
- **Offset Scenario**: Goes straight to Step 4
- **Constraints**: Depth and width must be strictly enforced at all steps

---

## Logic Sequence (Per Recursion Cycle)

**Request Scope Values:**
- User-provided namespace (unique identifier for their hierarchy)
- System maximum width and depth
- User-requested width and depth
- User-provided offset (default=0), active only for the first cycle

**Cycle Inputs:** Source Unit ID, UNIT ID, Optional Offset

> Always check both the mount namespace and request namespace for all steps if the unit is a `MOUNT` verb.

### Step 1: Mount Check
Check if `namespace/source/target/verb=MOUNT` exists.
- **If true**: Retrieve namespace ID from `verb_value` to be used as mount namespace for the remainder of the process
- **If false**: Continue with `namespace/source/target/verb=UNIT`, if it exists

### Step 2: Hide Check
Check if `(namespace or mount_namespace)/source/target/verb=HIDE` exists.
- **If true for either namespace**: Stop processing; continue with next sibling (if one exists) or return final result to user

### Step 3: Replacement Logic
Check if `(namespace or mount_namespace)/source/target/verb=REPLACE` exists.
- **If exists for mount namespace**:
  - Step 1: Replace unit ID with `mount_namespace/source/target/verb=REPLACE/verb_value=replace_with_unit_id`
  - Step 2: Replace unit ID with `namespace/source/target/verb=REPLACE/verb_value=replace_with_unit_id`
- **If exists only for request namespace**: Replace unit ID with `namespace/source/target/verb=REPLACE/verb_value`

### Step 4: Overlay Retrieval
Retrieve all unit IDs from `(namespace or mount_namespace)/source/target/verb=OVERLAY/order`.
Apply ordering rules from Step 5 to retrieve overlay units from the units table for every item; this enables immediate merging in proper order.

### Step 5: Merge Priority
- **If mounted**:
  1. Merge mount namespace's overlay unit payloads into the `UNIT`'s payload. Start with lowest order; highest order overrides all.
  2. Merge request namespace's overlay unit payloads into the `UNIT`'s payload. Start with lowest order; highest order overrides all. Request namespace always overrides mount namespace.
- **If not mounted**: Apply only request namespace overlays

### Step 6: Structure Update
Add final resolved unit with updated merged payload to JSON structure respecting the hierarchy of recursive traversal.

### Recursion Prep

### Step 7: Width Limitation
Retrieve user-requested width (respecting system maximums) of target records for the final resolved unit as source: `namespace/source`.
If offset provided, filter order key to be greater than the offset.

### Step 8: Recurse
Recurse each unit individually for another cycle according to user-requested depth (respecting system depth limits).
- Input: `source = final resolved unit's ID`, `target = target from Step 7`

---

## System Invariants

**Uniqueness Constraints:**
- Only ONE result permitted for `namespace/source/target/verb` combinations: `UNIT`, `REPLACE`, `HIDE`
- Multiple entries allowed for `namespace/source/target/verb=OVERLAY`
- Namespace IDs must be unique (enforced by `namespaces` database)

**Mount Constraints:**
- A mounted unit cannot be replaced within the same namespace in which it was mounted
- The hierarchy can only mount a non-mounted unit via `verb=UNIT`

**Limits (from .env):**
- `MAX_WIDTH=10` - Max target units resolved per request
- `MAX_DEPTH=2` - Max depth for sources resolved per request
- `MAX_OVERLAYS=5` - Max merge operations per unit

---

## Future Feature: Namespace Verb

A planned enhancement will add a `NAMESPACE` verb that allows additional namespace layers beyond the current request/mount system. After the mount namespace check (Step 1), the system will check for namespace verbs and apply them on top of mount/request with higher priority, while maintaining their own internal priority ordering among multiple namespace verbs.

---

## Database

LMDB databases stored in `data/composia.mdb`:
- `units` - Unit payloads
- `matrix` - Instruction relationships
- `namespaces` - Namespace registry for uniqueness

The Rust engine is initialized as a singleton in `src/dal/db.js`.
