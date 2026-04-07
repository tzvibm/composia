# Composia Architecture: Context Compiler with Hebbian Learning

## What This Is

Composia is a preprocessing layer between users and LLMs that replaces chat history with graph-assembled context. It maintains two graphs — a session graph (short-term) and a global graph (long-term) — with a Hebbian learning pipeline between them: nodes that co-occur across sessions get consolidated and promoted, strengthening edges that matter and letting unused ones decay.

It is not a knowledge base, not a RAG system, not a memory framework. It is a context compiler.

## Core Thesis

Chat history is structurally incapable of truth. It's an append-only log where hallucinations persist, compound, and become load-bearing context. There is no mechanism for verification, comparison, or synthesis.

A graph of discrete, verifiable nodes fixes this:
- Each node is an auditable claim that can be verified independently
- Contradictions between nodes are structurally detectable
- Humans can edit individual nodes without rewriting conversations
- Nodes can be compared against each other (by humans, by LLMs, by vector similarity)
- Creating a node forces synthesis — you can't ramble, you must distill
- Hallucinations die if never reinforced; truth gets reinforced through repetition

## Two Graphs

### Session Graph (short-term memory)
- Built fresh each session
- Every user prompt and LLM response is decomposed into nodes and edges
- The LLM never sees raw chat history — context is assembled from this graph
- Ephemeral: exists only for the session duration
- Nodes that prove useful get promoted to the global graph

### Global Graph (long-term memory)
- Persistent across all sessions
- Loaded at session start as the LLM's structural context
- Edges are weighted by reinforcement (how many times they've been activated)
- Nodes consolidate when the same concept appears repeatedly
- Heavy edges surface automatically; unreinforced edges decay

## The Pipeline: Short-Term → Long-Term

This is Hebbian learning: neurons that fire together wire together.

### Step 1: Vector Matching
When a new node is created in the session graph, its vector embedding is compared against all existing nodes in the global graph. If similarity exceeds a confidence threshold, a match is logged.

### Step 2: Match Accumulation
Matches are recorded but nothing happens immediately. The system waits for signal strength.

### Step 3: Consolidation Trigger
When a node accumulates N matches (e.g., 5) across sessions:
- The system collects all matched nodes
- Asks the LLM to synthesize their content into one canonical node
- **All edges from all matched nodes are preserved** — they now point to/from the consolidated node
- Edge weights are simply how many times that edge appeared across the duplicates
- The consolidated node is an abstraction that gains connections from every duplicate
- Presents the proposed consolidation to the user for approval

Consolidation merges the node. Edges stay intact. The node gets denser.

### Step 4: Edge Reinforcement (independent of consolidation)
Edges get reinforced simply by repetition. If `[[payments]] → [[idempotency]]` appears across 15 sessions, that edge has weight 15 — regardless of whether the payment node itself consolidated. Heavier edges surface more readily during context assembly.

Node consolidation and edge reinforcement are two independent processes, both driven by repetition alone. No rules, no special logic, just counting.

### Step 5: Promotion
The consolidated node lives in the global graph with all its accumulated edges. It surfaces automatically in future sessions when related topics come up. More edges = more connected = more likely to be traversed.

### Step 6: Decay
Nodes and edges that are never reinforced gradually lose weight. They stop surfacing in context assembly. Eventually they can be archived or pruned.

```
Session 1:  "auth uses jwt"           → node-A, edge: A→[[api-gateway]]
Session 3:  "jwt for api auth"        → node-B, edges: B→[[api-gateway]], B→[[tokens]]
Session 5:  "authentication via jwt"  → match logged (2)
Session 8:  "jwt because no sessions" → node-D, edges: D→[[api-gateway]], D→[[session-cookies]]
Session 11: "jwt over sessions"       → match logged (4)
Session 14: "jwt auth"                → match logged (5) → CONSOLIDATION TRIGGERED

Result: one canonical node-A' with ALL edges preserved:
  A' → [[api-gateway]]      weight: 3 (appeared in A, B, D)
  A' → [[tokens]]           weight: 1 (appeared in B)
  A' → [[session-cookies]]  weight: 1 (appeared in D)

The node consolidated. The edges stayed. The node got denser.
```

## The Context Loop

Every turn follows this cycle:

```
User prompt
    ↓
1. DECOMPOSE: Extract nodes and edges from prompt
    ↓
2. MATCH: Compare new nodes against session + global graph
    ↓
3. ASSEMBLE: Build context from graph traversal
   - Start with matched nodes
   - Follow weighted edges (heavier = more likely to include)
   - LLM evaluates which nodes to traverse (conditional edges)
   - Backlinks return accumulated context up the traversal path
    ↓
4. PRESENT: Show user proposed graph changes for approval
    ↓
5. APPROVE: User accepts/edits/rejects graph mutations
    ↓
6. SEND: Assembled graph context (not chat history) → LLM
    ↓
7. RECEIVE: LLM response
    ↓
8. DECOMPOSE: Extract nodes and edges from response
    ↓
9. UPDATE: Session graph updated, global graph matches logged
    ↓
10. PRESENT: Show user proposed changes from LLM response
    ↓
11. APPROVE: User accepts/edits/rejects
    ↓
→ Next turn (repeat from 1)
```

The chat messages are ephemeral transaction proposals. The graph is the durable artifact.

## Node Structure

Each node is a markdown file containing a discrete, verifiable unit of knowledge.

```markdown
---
vector: [0.12, -0.34, ...]     # embedding for similarity matching
weight: 12                      # reinforcement count
matches: 5                      # times similar nodes appeared
consolidated_from: [a, b, c]   # provenance: which nodes were merged
created: 2026-04-07
last_reinforced: 2026-04-07
---
# JWT Authentication

Chosen over session cookies because sessions don't work with the API gateway.
Stateless, RS256 signed, keys rotate weekly.

Links to: [[api-gateway]], [[session-cookies]], [[key-rotation]]
```

## Edge Structure

Edges are simple. Their weight is their repetition count.

- **Weight** — how many times this edge has appeared across sessions. Heavier = surfaces more.
- **Directional** — forward links (calls: "go get this context") and backlinks (returns: "here's what I contribute back")
- **Conditional** — some edges may only be relevant in certain contexts, evaluated by LLM at traversal time

No special edge logic. Edges get reinforced by appearing repeatedly across sessions. That's it.

## What Composia Is NOT

- Not a note-taking app (Obsidian)
- Not a memory layer bolted onto chat history (Mem0, Zep)
- Not a RAG system that retrieves chunks (vector DBs)
- Not a knowledge graph you query separately (Neo4j)

It is a context compiler that sits in the LLM call path, replacing chat history with graph-assembled, human-approved, Hebbian-reinforced context.

## Prior Art (honest)

| System | What it does | How Composia differs |
|---|---|---|
| Mem0 / Zep / Graphiti | Extract entities from chat into graph, use as supplementary context alongside chat history | Composia replaces chat history entirely with graph context. Mem0 bolts memory onto a broken foundation. |
| LangGraph Agentic RAG | Iterative retrieve-grade-rewrite loops | Nodes are passive data retrieved for the LLM. In Composia, nodes are executable context-steering documents with conditional edges. |
| Graph of Thoughts | Ephemeral reasoning graphs built per query | Composia's graphs are persistent and learn across sessions via reinforcement. |
| Vector databases | Similarity search over chunks | No graph structure, no reinforcement, no consolidation, no edge weights. |
| Chat history | Append-only message log | The thing Composia replaces. |

## Open Questions

- What embedding model for vector matching? (Local vs API — latency matters since it's in the hot path)
- Consolidation threshold: 5 matches? Configurable? Should it vary by domain?
- Decay rate: linear? exponential? Based on time or session count?
- How much of the global graph to load at session start? (At scale, can't load everything)
- Approval UX: CLI diff? TUI? Web UI? What does "show proposed graph changes" actually look like?
- How to handle the first session (empty global graph, cold start)?
- Edge condition syntax: natural language evaluated by LLM? Structured expressions? Both?
- Backlink return semantics: what exactly does "carry context back" mean in implementation?
