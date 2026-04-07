# Composia: Graph-Native Context Compiler

## What This Is

Composia is a context processing system that replaces chat history with graph-assembled context. It sits between the user and the LLM as a preprocessing and postprocessing layer. Every input (user prompt, LLM response, book chapter, code file) is decomposed into nodes and edges. Context is never an append-only log — it is always assembled from the graph.

The system maintains two graphs:
- **Session graph** — short-term, built during the current interaction, ephemeral
- **Global graph** — long-term, persistent across all sessions, learns through reinforcement

The pipeline between them is Hebbian: nodes that appear repeatedly get consolidated, edges that repeat get reinforced. Truth converges. Hallucinations decay.

## Why Chat History Is Broken

Chat history is an append-only log. It has no structural mechanism for truth.

- If turn 3 hallucinates, turns 4-20 build on it. The hallucination becomes load-bearing context.
- There is no way to verify, compare, or contradict a specific claim — it's buried in a wall of text.
- Nothing forces synthesis. Messages just accumulate.
- The context window fills with noise. Relevant information from turn 2 gets pushed out by irrelevant information from turn 18.
- There is no learning. Session 50 has the same cold-start problem as session 1.

Every existing system (Mem0, Zep, Graphiti, LangMem) bolts a graph onto this broken foundation. They extract entities from chat history and store them in a graph, but the chat history remains the primary context sent to the LLM. The graph is supplementary. The broken foundation stays.

Composia replaces the foundation. The graph is the context. Chat messages are ephemeral proposals that get decomposed into graph mutations, approved by the user, and discarded. Only the graph persists.

## Nodes

A node is a markdown file. It represents a discrete, verifiable unit of knowledge — a claim, a concept, a fact, a question, an answer.

A node is also a piece of **context-steering data**. It exists to be ingested into the LLM's context when traversal conditions are met, or simply by being linked. Every node is simultaneously content (readable information) and an instruction (when this topic comes up, this matters).

```markdown
---
vector: [0.12, -0.34, ...]
weight: 14
matches: 7
consolidated_from: [node-a, node-b, node-c]
created: 2026-04-07
last_reinforced: 2026-04-12
---
# JWT Authentication

Chosen over session cookies because sessions are stateful
and break with the API gateway's load balancing.
Stateless, RS256 signed, keys rotate weekly via [[key-rotation]].

See [[api-gateway]] for routing, [[session-cookies]] for
the alternative we rejected.
```

### Node properties

- **vector** — embedding for similarity matching against other nodes
- **weight** — how many times this node or similar nodes have been reinforced
- **matches** — count of vector-similar nodes detected before consolidation
- **consolidated_from** — provenance trail of which nodes were merged into this one
- **content** — the actual markdown, readable by humans and LLMs
- **edges** — forward links (outgoing) and backlinks (incoming), each with their own weight

## Edges

An edge is a connection between two nodes. It has two properties that matter: direction and weight.

**Forward links** are like function calls. They say: "go get this context." When a node is being traversed and has a forward link, the system follows it to pull in that node's content.

**Backlinks** are like return statements. They carry context back to the caller. When the system traverses from node A to node B via a forward link, node B's backlink to A carries B's relevant content back up the traversal path, enriching A's context.

**Weight** is purely repetition count. If the edge `auth → jwt` has appeared in 22 sessions, its weight is 22. Heavier edges are more likely to be followed during context assembly. No rules, no special logic. Just counting how many times the connection appeared.

Edges can span multiple hops. The path `auth → jwt → api-gateway → rate-limiting → redis` might never have been explicitly stated anywhere, but each individual edge was reinforced independently across different sessions. The system discovers multi-hop relationships that no single source ever articulated.

### Edge reinforcement is independent of node consolidation

A node can consolidate (merge its content with similar nodes) without affecting any edges. An edge can be reinforced (increase its weight) without any node consolidating. Both processes are driven by repetition, but they operate independently.

## Two Graphs

### Session Graph (short-term)

Built fresh when a session starts. Every user prompt and LLM response during the session is decomposed into nodes and edges that get added to this graph.

The session graph grows throughout the interaction. New connections are discovered. Edges between session nodes get reinforced within the session as topics recur. The session graph is the working memory — it represents what is being discussed right now.

At session end, the session graph is compared against the global graph. Matches are logged. If any node hits the consolidation threshold, consolidation is triggered. Reinforced edges update the global graph's edge weights.

The session graph is ephemeral. It does not persist after the session ends. Its contribution to the global graph (via matches and reinforcement) is what persists.

### Global Graph (long-term)

Persistent across all sessions. This is the system's learned knowledge — the accumulated, consolidated, reinforced graph of everything it has processed.

At session start, the global graph is loaded as the system's structural context. The LLM knows what nodes exist, their summaries, their edge weights. It does not receive the full content of every node — it receives the graph structure and summaries, then traverses into specific nodes as needed.

The global graph grows denser over time. Nodes that represent the same concept across multiple sessions get consolidated into single, canonical nodes. Edges that appear repeatedly get heavier. Nodes and edges that are never reinforced decay and eventually get pruned.

The global graph is how the system learns. After processing 10 books on distributed systems, the graph has heavy, dense nodes for consensus, replication, and partitioning — because every book mentions them. Niche ideas from one book stay low-weight.

## The Hebbian Pipeline: Short-Term to Long-Term

Neurons that fire together wire together. Nodes that co-occur across sessions get consolidated. Edges that repeat get reinforced.

### 1. Vector Matching

When a new node is created (in a session graph or during ingestion), its vector embedding is compared against all existing nodes in the global graph. If similarity exceeds a confidence threshold, a match is logged against the existing node.

### 2. Match Accumulation

Matches are recorded but nothing happens immediately. The system counts and waits for signal strength. One match could be noise. Five matches is a pattern.

### 3. Consolidation Trigger

When a node in the global graph accumulates N matches (e.g., 5):
- The system collects all matched nodes (the original + the N duplicates)
- The LLM synthesizes their content into one canonical node
- **All edges from all matched nodes are preserved intact** — they now point to/from the consolidated node
- The consolidated node is an abstraction that inherits every connection from every duplicate
- The user is shown the proposed consolidation for approval

Consolidation merges the node. The edges stay. The node gets denser — more connections, not fewer.

```
Before:
  node-A → [[gateway]]              (from session 1)
  node-B → [[gateway]], [[tokens]]  (from session 3)
  node-D → [[gateway]], [[cookies]] (from session 8)

After consolidation (A + B + D → A'):
  node-A' → [[gateway]]    weight: 3
  node-A' → [[tokens]]     weight: 1
  node-A' → [[cookies]]    weight: 1

Content of A' is LLM-synthesized from A, B, D.
All edges preserved. Node is denser.
```

### 4. Edge Reinforcement

Independent of consolidation. Every time an edge appears in a session, its weight in the global graph increments by 1. If `payments → idempotency` appears in 15 sessions, that edge has weight 15. Heavier edges surface more readily during context assembly.

### 5. Decay

Nodes and edges that are never reinforced lose weight over time. Low-weight nodes stop appearing in context assembly results. Eventually they are pruned.

This is how hallucinations die. A hallucinated fact creates a node with weight 1. It is never reinforced because no other session or source produces the same claim. It decays. Truth, on the other hand, gets reinforced — multiple sources and sessions produce the same concept, driving up weight. The system structurally converges toward truth and away from noise.

## Ingestion: Books, Code, Docs

The system is trained by reading. Any input that can be chunked into sessions feeds the same Hebbian loop.

### Books

A book is a sequence of sessions. Each chapter (or section, or paragraph — granularity is configurable) is processed as a session:

```
Chapter 1  → session → nodes + edges created
Chapter 2  → session → new nodes, matches against ch1 logged
Chapter 3  → session → edges reinforced, new connections
...
Chapter 20 → session → consolidation triggers firing,
                        core concepts have heavy edges,
                        peripheral details low-weight
```

After one book, the graph represents that book's knowledge structure — emergent, not authored. After 10 books on the same topic, the graph represents the domain. Concepts that every book mentions have heavy nodes with dense edges. Ideas from a single book stay low-weight.

### Academic books specifically

Academic books are structured as questions and answers. This maps directly to the graph:

- A **question** is a graph with unfilled edges — gaps that need resolution
- An **answer** is a graph that fills those gaps
- **Cross-references** are edges (the book's own links between concepts)
- The **index** is literally a node lookup table

The system doesn't need special handling for academic structure. Questions become nodes with unresolved edges. Answers become nodes that connect to those edges. The graph naturally represents the book's knowledge structure.

### Codebases

Each file is a session. Imports are edges. Function calls are edges. The graph represents the codebase's dependency and call structure.

### Documentation

Each page is a session. Cross-references are edges. After ingesting a documentation site, the graph represents its information architecture.

### Conversations

Each chat session is a session (the original use case). User messages and LLM responses are decomposed into nodes and edges. The session graph captures what was discussed. Reinforcement across sessions captures what matters.

The input format doesn't matter. Everything feeds the same loop: decompose → match → reinforce → consolidate.

## The Query Loop: Convergence-Based Answering

When a user asks a question, the system does not produce an immediate answer. It iterates until the session graph converges — until new iterations reinforce existing edges instead of discovering new ones.

### How a query is processed

**1. Decompose the prompt into a graph query**

The user's prompt is not text to pass to an LLM. It is a graph with missing nodes — a question structure.

```
User: "How should I handle auth in this microservice?"

Decomposed:
  Node: "auth" (concept, needs resolution)
  Node: "microservice" (context constraint)
  Edge: auth → microservice (scoped: "auth IN this microservice")
  Type: "how" (seeking approach/pattern)
```

**2. RAG finds dominant nodes**

The system uses vector similarity to find the highest-weight nodes in the global graph that match the query's nodes. Weight matters — heavily reinforced nodes surface first.

```
Matches:
  auth          weight: 47
  jwt           weight: 32
  api-gateway   weight: 28
  sessions      weight: 3  (weak)
```

**3. Find strongest edges between matched nodes**

The system looks for high-weight paths connecting the matched nodes. These paths represent the strongest relationships the system has learned.

```
Paths:
  auth → jwt           weight: 22
  jwt → api-gateway    weight: 18
  auth → sessions      weight: 3 (weak, might be mentioned as alternative)
```

**4. Load actual content of high-weight nodes into LLM context**

The content of the nodes along the strongest paths is assembled into the LLM's context. Not chat history — graph content, selected by edge weight.

**5. LLM produces output**

The LLM responds based on graph-assembled context.

**6. Decompose the output into new nodes and edges**

The LLM's response is decomposed. New nodes and edges are added to the session graph. Possibly a new connection is discovered: `jwt → rate-limiting` (the LLM mentioned this relationship).

**7. RAG again with enriched session graph**

With the session graph now larger, the system finds nodes missed on the first pass — reachable now through newly created edges.

**8. Repeat until convergence**

The loop continues. Each iteration:
- Decomposes new content into nodes/edges
- Matches against session + global graph
- Loads new node content into context
- LLM produces refined output

**9. Detect convergence**

The system monitors whether new iterations are producing new nodes/edges or just reinforcing existing ones. When the session graph stabilizes — new iterations don't change the graph structure — the system has converged.

Convergence = confidence. The answer is ready.

**10. Produce summary**

The system synthesizes a final output from the converged session graph and presents it to the user.

```
Convergence:
  Iteration 1: 8 new nodes, 12 new edges
  Iteration 2: 4 new nodes, 6 new edges, 3 reinforced
  Iteration 3: 1 new node, 2 new edges, 8 reinforced
  Iteration 4: 0 new nodes, 0 new edges, 11 reinforced
  → CONVERGED → produce answer
```

A well-known topic (heavy nodes, strong edges) converges in 1-2 iterations. A novel or complex question takes more loops. The system self-regulates — it doesn't have a fixed number of steps.

## Human in the Loop

The user is the quality gate. At every graph mutation point, the system presents proposed changes for approval:

- After decomposing a user prompt: "I'm creating these nodes and edges. Approve?"
- After decomposing an LLM response: "The LLM's output implies these graph changes. Approve?"
- At consolidation: "These 5 nodes say similar things. Here's the proposed merge. Approve?"

The user can:
- **Approve** — changes are committed to the graph
- **Edit** — modify the proposed nodes/edges before committing
- **Reject** — changes are discarded, the graph is unchanged

This is why the system can't silently accumulate garbage the way Mem0/Zep entity extraction does (~70% accuracy, errors compound silently). Every mutation is auditable. The human sees what goes into the graph.

For bulk ingestion (books, codebases), the approval step can be batched or configured with automatic approval at a confidence threshold. But the mechanism exists — the graph is never a black box.

## What This Is Not

**Not a memory layer.** Memory systems (Mem0, Zep, LangMem) bolt a graph onto chat history. The chat history is still the primary context. The graph is supplementary. Composia replaces chat history entirely.

**Not a RAG system.** RAG retrieves chunks and stuffs them into the context window alongside the conversation. There is no graph structure, no reinforcement, no consolidation, no convergence loop. Composia doesn't retrieve chunks — it assembles context by traversing a weighted, evolving graph.

**Not a knowledge base you query separately.** Neo4j, Obsidian, and traditional knowledge graphs are databases you query from an application. Composia is in the LLM call path — it preprocesses every prompt and postprocesses every response. It's not a tool the LLM calls; it's the layer the LLM runs on.

**Not a note-taking app.** Obsidian is for humans writing personal notes. Composia is a context compiler. The markdown files are a serialization format for graph nodes, not documents for humans to browse.

## How It Differs From Everything Else

| System | Context source | Graph role | Learning | Quality gate |
|---|---|---|---|---|
| Standard LLM | Chat history | None | None | None |
| RAG | Chat history + retrieved chunks | None | None | None |
| Mem0 / Zep | Chat history + graph memories | Supplementary | Entity extraction (one-shot) | None (silent) |
| Graphiti | Chat history + temporal graph | Supplementary | Incremental entity extraction | None (silent) |
| Graph of Thoughts | Ephemeral per-query graph | Primary but ephemeral | None (rebuilt each time) | None |
| **Composia** | **Graph only (no chat history)** | **Primary and persistent** | **Hebbian (reinforcement + consolidation)** | **Human approval** |

The row that matters: Composia is the only system where the graph is both the primary context source AND persistent AND learns through reinforcement AND has human oversight.

## The Core Mechanism in One Sentence

Every input is decomposed into graph nodes and edges; repeated nodes consolidate into abstractions while preserving all edges; repeated edges get reinforced; the system converges toward truth because truth is reinforced and hallucinations are not.

## Open Questions

- **Embedding model**: local (fast, private) vs API (better quality, latency cost). Since vector matching is in the hot path of every turn, latency matters.
- **Consolidation threshold**: 5 matches is a starting point. Should it be configurable? Should it vary by domain or node type?
- **Decay function**: linear, exponential, or based on session count rather than time?
- **Global graph loading**: at scale, the full graph can't fit in context at session start. What's the strategy for loading relevant subgraphs?
- **Approval UX**: CLI diffs, TUI, web UI? What does "show proposed graph changes" look like in practice?
- **Cold start**: first session with an empty global graph. How does the system bootstrap?
- **Convergence detection**: what metric determines that the session graph has stabilized? Node/edge creation rate? Information entropy? Something simpler?
- **Backlink return semantics**: when node B returns context to node A via a backlink, what exactly is carried back? Full content? Summary? Specific fields?
- **Edge conditions**: natural language evaluated by LLM at traversal time? Structured expressions? Both?
- **Granularity of decomposition**: how fine-grained should node extraction be? Sentence-level? Paragraph-level? Concept-level? Probably LLM-determined, but the prompt for decomposition matters.
