# 🌌 Composia

**The Sovereign Composition Engine.**

Composia is a backend-driven orchestration system that assembles complex, hierarchical data structures (trees) on the fly. Unlike traditional fixed-hierarchy databases, Composia uses an **Instruction Matrix** to "stitch" together atomic units of data based on the caller's authority (Namespace).

---

## 🏗 System Architecture

Composia follows a strict "Nervous System" flow, from the external request down to the recursive database engine.

### 1. The API Layer (The Request)

The entry point for all compositions.

* **Input:** A `Root Unit ID` and a set of `Active Namespaces`.
* **Role:** Validates the environment invariants (Max Depth, Max Width) and passes the "Sovereign Context" to the service layer.

### 2. The Service Layer / Stitcher (The Brain)

The core logic resides here. It manages the lifecycle of the composition.

* **Flow Control:** Orchestrates the transition from raw database rows to a nested JSON tree.
* **Access Control:** Enforces sovereignty. If a namespace isn't in the "Active" list, its instructions are invisible, effectively changing the structure of the data for different users/roles.

### 3. The CTE Engine (The Heart)

A Recursive Common Table Expression (CTE) that performs a **Hydrated Walk** of the data.

* **Vertical Traversal:** Moves from `source` (parent) to `target` (child).
* **Look-Ahead Pruning:** Evaluates "Logic Verbs" (`HIDE`, `SOLO`) before expanding branches to ensure the engine only fetches what is necessary.

### 4. The Database (The Memory)

The persistence layer is split into two specialized tables:

* **Units:** Immutable "Atoms" containing raw JSON payloads and labels.
* **Instruction Matrix:** The "Instruction Set" (Registers). It defines the relationships between units using `source`, `target`, `verb`, `value`, `namespace`, and `order`.

---

## ⚡ The Execution Pipeline (The Blueprint)

When a request is made, the system executes the following phases for every node:

1. **Context Collection:** Gather all instructions belonging to the current unit and active namespaces.
2. **Logic & Pruning:** Apply "Stopper" verbs (e.g., `HIDE` an instruction or `SOLO` a namespace) to filter the execution path.
3. **Hydration:** Fetch the actual `payload` from the Units table for all surviving targets.
4. **Modification:** Apply `MERGE` or `OVERLAY` operations to the payload based on the instruction value.
5. **Recursion:** Treat the children as new roots and repeat until the leaf nodes are reached or Invariants are hit.

---

## 🛡 Security & Access Control: Sovereignty

In Composia, **Access Control is Structural**.
Instead of simple "Allow/Deny" permissions on a row, namespaces allow different authorities to redefine the tree.

* **Admin Namespace:** May see a "Delete" button unit as a child of a dashboard.
* **User Namespace:** May have that same child "Hidden" via a `HIDE` instruction.
The data remains the same; the **Composition** changes.

---

## 🛠 Tech Stack

* **Language:** TypeScript / Node.js
* **Database:** PostgreSQL (Recursive CTEs, JSONB)
* **Architecture:** Instruction-based Composition

---

## 🚥 System Invariants

To prevent infinite loops and memory exhaustion, the system enforces the following environment-level limits:

* `MAX_DEPTH`: Maximum levels of recursion.
* `MAX_WIDTH`: Maximum children per node.
* `MAX_NAMESPACE`: Maximum active authorities per request.
* `MAX_OVERLAYS`: Maximum merge operations per unit.