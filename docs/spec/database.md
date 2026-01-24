# Component: Database (Instruction Matrix)

The database layer serves as the **Persistent Instruction Set** for the Composia ecosystem. It is divided into two logical tiers: Atomic Storage and the Instruction Matrix.

## 1. Schema Definitions

### 1.1 Unit Storage (Atoms)

The storage tier for data nodes. These units are completely "context-blind" and contain no information about their position in a hierarchy.

* **Identity**: A 32-bit hash (Hex string) acting as a unique fingerprint.
* **Label**: A human-readable descriptor for administrative tracking.
* **Payload**: A flexible JSONB structure containing the unit's data.
* **Temporal Data**: Creation timestamps for version auditing.

### 1.2 Instruction Matrix (The VM Registers)

The logic tier that defines how atoms are composed. This table is structured as a series of registers that the **Stitcher** executes in a top-down pass.

| Register | Technical Requirement | Logical Role |
| --- | --- | --- |
| **Source** | 32-bit Hash (Ref: Unit) | **The Context**: The unit acting as the origin or "parent" for the instruction. |
| **Target** | String / Reference | **The Subject**: The Unit ID or Instruction PK being acted upon by the verb. |
| **Verb** | Enumerated String | **The OpCode**: The specific logic to execute (e.g., `CHILD`, `MOUNT`, `HIDE`). |
| **Value** | Flexible String/Text | **Parameters**: Supporting data required by the verb (e.g., Target Namespace). |
| **Namespace** | String | **Sovereignty**: The authority/owner of this specific instruction. |
| **Order** | Integer | **Priority/Sequence**: Deterministic rank for sibling position and merge overrides. |

---

## 2. Structural Integrity Rules

### 2.1 Determinism Constraint

To ensure the Stitcher always produces the same result from the same data, the database enforces a **Uniqueness Constraint** across the combination of `Source`, `Target`, `Verb`, `Namespace`, and `Order`. This prevents ambiguous "race conditions" in the logic.

### 2.2 Relational Strictness

Every **Source** register must map to a valid record in the Unit Storage. However, the **Target** is polymorphic (it can be a Unit ID or an Instruction PK), so it remains a flexible reference to support the "Stitcher" pruning logic.

---

## 3. Access Patterns

The database is optimized for a **Top-Down Recursive Seek**.

* **Primary Query Pattern**: Finding all instructions belonging to a specific `Source` and a set of `Active Namespaces`, sorted by `Order`.
* **Optimization Strategy**: Composite indexing is applied to the `Source + Namespace + Order` path to ensure sub-millisecond resolution during the recursive walk.