# Entity-Relationship Bitmask System

## Specification v1.1

---

## Abstract

A minimal, high-performance access control system where everything is an entity, relationships are bitmasks, and capability semantics are defined per-entity. The system achieves O(log N) lookup and O(1) evaluation with linear scaling, no global schema, and deterministic ordering via epochs.

---

## 1. Core Abstraction

Everything is an **entity**. The system doesn't know what entities represent—that's business context. Entities could be users, teams, apps, rooms, dates, events, services, or anything else.

The storage layer contains only:
- IDs
- Bitmasks
- Epochs

No types. No schema. Just paths and bits.

---

## 2. Path Patterns

Six patterns define the entire system:

| Pattern | Purpose |
|---------|---------|
| `entity/rel_mask/entity` | Relationship between entities |
| `entity/policy/entity` | Conditional relationship (code outputs rel_mask) |
| `entity/rel_mask/cap_mask` | Capability definition (per-entity) |
| `entity/entity/entity` | Inheritance reference |
| `entity/rel_mask/label` | Human-readable relationship name |
| `entity/cap_mask/label` | Human-readable capability name |

All paths store **epoch** as value.

---

## 3. Relationships

```
john/0x02/slack → epoch
```

Entity "john" has relationship bits `0x02` with entity "slack".

The system doesn't know john is a user or slack is an app. That's business knowledge (sub-DB organization, application logic, naming conventions).

---

## 4. Policies (Conditional Relationships)

```
john/policy/slack → epoch
```

A **policy** is a conditional relationship where code evaluates context and outputs a rel_mask.

Unlike static relationships (`entity/rel_mask/entity`), policies are dynamic:

```
john/0x02/slack           → static: john always has 0x02 on slack
john/policy/slack         → dynamic: code evaluates and returns rel_mask
```

### Policy Evaluation

The policy contains or references code that:
1. Receives context (time, location, device, request attributes, etc.)
2. Evaluates conditions
3. Returns a rel_mask (or 0x00 for no relationship)

```
policy for john/policy/slack:
  if time.hour >= 9 && time.hour <= 17:
    return 0x02  // editor during work hours
  else:
    return 0x01  // viewer outside work hours
```

### Why Policies

| Static Relationship | Policy |
|---------------------|--------|
| Always same rel_mask | Context-dependent rel_mask |
| O(1) lookup | O(1) lookup + code execution |
| No conditions | Time, location, device, etc. |
| Deterministic | Deterministic given same context |

Policies add ABAC-style conditions while preserving bitmask evaluation. The output is still a rel_mask—capability evaluation remains O(1).

### Storage

```
entity/policy/entity → epoch (+ policy code reference)
```

Policy code can be:
- Inline (small expressions)
- Referenced (pointer to code/WASM module)
- External (call to policy service)

---

## 5. Capability Definitions

```
slack/0x02/cap_mask → epoch
```

Entity "slack" defines what relationship `0x02` means: which capability bits are granted.

**Key insight:** The same relationship bit means different things to different entities.

```
slack/0x02/cap_mask → 0x0F    (editor in slack: read, write, delete, admin)
github/0x02/cap_mask → 0x03   (editor in github: read, write only)
```

No global role definitions. Each entity owns its semantics.

---

## 6. Inheritance

```
entity1/entity2/entity3 → epoch
```

Entity1 inherits entity3's relationship mask for entity2.

**Example:**
```
john/sales/mary → epoch
```

John inherits whatever relationship mary has with sales.

If `mary/0x04/sales` exists, john effectively has `0x04` on sales via inheritance.

### Two Forms of Inheritance

| Form | Path | Meaning |
|------|------|---------|
| Reference | `john/sales/mary` | john inherits mary's relationship to sales |
| Scoped path | `sales/0x02/companyx/john` | john has 0x02 on sales, scoped to companyx context |

---

## 7. Hierarchical Scoping

Entities can be scoped by prepending context:

```
engineering/john/0x04/slack → epoch
```

John, in the context of engineering, has relationship `0x04` with slack.

---

## 8. Bidirectional Storage

Every write is transactional on forward and reverse paths:

```
Transaction:
  john/0x02/sales → epoch
  sales/0x02/john → epoch
```

For inheritance:
```
Transaction:
  john/sales/mary → epoch
  mary/sales/john → epoch
```

Enables O(log N) queries from either direction:
- "What can john access?" → scan `john/*/*`
- "Who can access sales?" → scan `sales/*/*`

---

## 9. Access Evaluation

Three to four lookups, left to right:

**Query:** Can entity1 perform action on entity2?

```
Step 1: entity1/*/entity2
        → get all existing rel_masks (direct relationships)
        → includes static (rel_mask) and dynamic (policy)

Step 1b: If policy exists (entity1/policy/entity2)
        → execute policy code with context
        → policy returns rel_mask (or 0x00)

Step 2: entity1/entity2/*
        → if inheritance exists, get entity3
        → do step 1 for entity3 (inherited relationships)

Step 3: entity2/rel_mask/cap_mask
        → for each rel_mask from steps 1, 1b, and 2
        → if rel_mask matches, get capability bits
        → evaluate requested action against capability bits
```

### Example

```
Can john delete in sales? (delete = bit 2)

1. john/*/sales → 0x02 (direct relationship)

2. john/sales/* → mary (inheritance reference)
   mary/*/sales → 0x04 (mary's relationship)

3. sales/0x02/cap_mask → 0x03 (bits 0,1: read, write)
   sales/0x04/cap_mask → 0x0F (bits 0,1,2,3: read, write, delete, admin)

Direct (0x02):    0x03 & 0x04 = 0 (no delete bit)
Inherited (0x04): 0x0F & 0x04 ≠ 0 (has delete bit)

Result: GRANTED via inheritance from mary
```

---

## 10. Labels

Human-readable names for relationships and capabilities:

```
sales/0x02/label → "member"
sales/0x04/label → "manager"
sales/0x03/cap_label → "read,write"
sales/0x0F/cap_label → "read,write,delete,admin"
```

Labels are metadata. The system operates on bits, not names.

---

## 11. Implementation

### Storage

- **Engine:** LMDB (embedded, ACID, MVCC)
- **Language:** Rust
- **Keys:** Path strings or fixed-size binary
- **Values:** Epochs (and bitmasks for cap_mask paths)

### Sub-DB Organization

Deployment choice. Examples:
```
LMDB
├── relationships/    (entity/rel_mask/entity)
├── reverse/          (entity/rel_mask/entity reversed)
├── policies/         (entity/policy/entity)
├── policies_rev/     (reversed)
├── inheritance/      (entity/entity/entity)
├── inheritance_rev/  (reversed)
├── capabilities/     (entity/rel_mask/cap_mask)
└── labels/           (entity/rel_mask/label, entity/cap_mask/label)
```

Types (user, app, team, etc.) are implicit—known to the business layer, not encoded in paths.

---

## 12. Complexity

| Operation | Complexity |
|-----------|------------|
| Key lookup | O(log N) via B-tree |
| Prefix scan | O(log N + K), K = results |
| Bitmask evaluation | O(1) |
| Access check (3 lookups) | O(log N) |

### Scaling

**Scenario:** 1M entities, 64 relationship bits, average 100 relationships per entity

- Relationship entries: 100M (forward) + 100M (reverse)
- Capability definitions: O(entities × 64) worst case
- No combinatorial explosion
- Linear growth with entities and relationships

---

## 13. Epochs

Every entry stores an epoch as its value:

```
john/0x02/sales → 1706400000001
sales/0x02/john → 1706400000001
```

Epochs provide:
- Global ordering of all writes
- Conflict resolution (higher epoch wins)
- Cache invalidation signals
- Audit trail timestamps

---

## 14. Properties

| Property | Mechanism |
|----------|-----------|
| **Type agnostic** | No types in paths; business layer defines meaning |
| **Linear scaling** | Bitmasks, not named roles |
| **O(log N) access** | LMDB B-tree lookups |
| **O(1) evaluation** | Bitmask AND operation |
| **Per-entity semantics** | Each entity defines its own capability mappings |
| **Conditional access** | Policies output rel_masks based on context |
| **Inheritance** | Path reference, not graph traversal |
| **Deterministic** | Epochs order all operations |
| **ACID** | Transactional forward/reverse writes |
| **Bidirectional** | Query from either entity's perspective |

---

## 15. Comparison

| Traditional Systems | This System |
|--------------------|-------------|
| Global role definitions | Per-entity capability mappings |
| Type system (user, resource, role) | Pure IDs |
| Named roles | Bitmasks |
| Role-capability tables | `entity/rel_mask/cap_mask` paths |
| Inheritance graphs | `entity/entity/entity` references |
| ABAC policy languages | Policies that output bitmasks |
| Complex policy evaluation | Bitmask AND (policy output → bitmask) |
| Combinatorial scaling | Linear scaling |
| Schema migrations | No schema |

---

## 16. Use Cases

Because it's just `id/bits/id`, the system can model:

- Access control
- Team membership
- Feature flags
- Capability discovery
- Tagging systems
- Relationship graphs
- Scheduling (date/event relationships)
- Physical access (badge/room relationships)
- Any directed relationship with attributes

The system doesn't know what it's modeling. It stores paths and bits.

---

## 17. Summary

The entire system is six path patterns:

```
entity/rel_mask/entity           → relationship (static)
entity/policy/entity             → relationship (conditional, code outputs rel_mask)
entity/rel_mask/cap_mask         → capability definition
entity/entity/entity             → inheritance
entity/rel_mask/label            → relationship name
entity/cap_mask/label            → capability name
```

Forward + reverse stored atomically. LMDB for O(log N) lookup. Bitmasks for O(1) evaluation. Epochs for ordering. Policies for conditional access. Types are business context, not system schema.

**The insight:** Remove everything except paths and bits. Let the business layer assign meaning. Use policies when context-dependent decisions are needed—they still output bitmasks, preserving O(1) capability evaluation.
