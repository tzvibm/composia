# Composia System Invariants

These invariants are the "Laws of Physics" for the Composia ecosystem. They are enforced by the **Instruction Matrix** (storage) and the **Stitcher** (execution engine) to ensure predictable, high-performance, and auditable data assembly.


## 1. Default Namespace Sovereignty

* **Definition:** Authority is hardcoded to the **Relationship** (the edge), not the Unit (the node).
* **Logic:** Units are atomic payloads and context-blind. Sovereign context is established only when an instruction is registered within a specific `namespace`.
* **Constraint:** Every record in the `instruction_matrix` must belong to a namespace. If no user-specific namespace is provided, the engine defaults to the `SYSTEM` namespace to resolve the base hierarchy.


## 2. Execution Width (Sibling Limit)

* **Definition:** The maximum number of instructions (siblings) processed for a single `source` register within a specific namespace.
* **Logic:** Prevents "Sibling Explosion" where a single unit attempts to resolve an unmanageable number of children, protecting the Stitcher's memory and performance.
* **Constraint:** The `order` register must be within a bounded range (default: **0 to 100**). Any instructions exceeding the `MAX_WIDTH` are ignored during the resolution pass.


## 3. Recursion Depth (Circuit Breaker)

* **Definition:** The maximum distance the Stitcher can travel from the Root Unit.
* **Logic:** Protects against infinite loops (e.g., `A -> B -> A`). Since we do not store a `depth` field in the database, the Stitcher maintains a runtime counter during traversal.
* **Constraint:** Once the counter hits `MAX_DEPTH` (default: 10), the Stitcher terminates that branch immediately, preventing a stack overflow.


## 4. Source-Only Mounting

* **Definition:** A `MOUNT` instruction can only be triggered by a **Source Unit**.
* **Logic:** You cannot mount an instruction; you can only mount a Unit that contains its own instruction set. This keeps the authority stack flat.
* **Constraint:** When a `MOUNT` verb is encountered, the Stitcher jumps context to the target unit in the specified namespace. Any further nested mounts are treated as fresh entry points.


## 5. Overlay Saturation (Merge Limit)

* **Definition:** The maximum number of `OVERLAY` instructions applied to a single unit in one pass.
* **Logic:** Prevents "Merge Bloat" where a unit is buried under too many conflicting or redundant patches, ensuring the merge operation remains  relative to the unit size.
* **Constraint:** The Stitcher will only apply up to `MAX_OVERLAYS` (default: 5). If more exist, only those with the highest `order` (priority) are processed.


## 6. Namespace Authority Ceiling

* **Definition:** The maximum number of simultaneous namespaces (sovereign contexts) evaluated during a single request.
* **Logic:** Keeps the SQL `IN` clause and the Stitcher's filtering logic from becoming a bottleneck as the number of users/tenants grows.
* **Constraint:** A single request may only resolve across up to `MAX_NAMESPACES` (default: 10). This includes the `SYSTEM` namespace, the user's namespace, and any injected via `MOUNT` or `NAMESPACE` verbs.

---

### Summary of Constraints

| Invariant | Enforced By | Failure Mode |
| --- | --- | --- |
| **Namespace** | `instruction_matrix.namespace` | Instruction Ignored |
| **Width** | `order` Register Limit | Branch Truncation |
| **Depth** | Stitcher Runtime Counter | Recursion Termination |
| **Mounting** | Verb Logic & Source-Only Rule | Execution Error |
| **Overlays** | Overlay Counter per Unit | Excess Overlays Ignored |
| **Namespaces** | Active Context Array Size | Authority Truncation |