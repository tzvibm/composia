# Composia: Graph-Native Context Compiler

## What This Is

Composia is a context processing system that replaces chat history with graph-constructed context. It sits between the user and the LLM as a preprocessing and postprocessing layer. Every input (user prompt, LLM response, book chapter, code file) is decomposed into nodes and edges.

The system maintains two graphs with distinct roles:
- **Session graph** — short-term, built during the current interaction, ephemeral. **This is the constructed context. The answer comes from here.**
- **Global graph** — long-term, persistent across all sessions, learns through reinforcement. **This is a learned prior. It proposes candidate nodes ("visitors") that may influence the session graph, but it does not produce answers directly.**

The global graph is not a retrieval store. It does not supply answer content. It biases which concepts are considered — like a prior probability distribution over knowledge. The session graph is the only structure that produces the answer.

The pipeline between them is Hebbian: nodes that appear repeatedly get consolidated, edges that repeat get reinforced. Truth converges. Hallucinations decay.

## Why Chat History Is Broken

Chat history is an append-only log. It has no structural mechanism for truth.

- If turn 3 hallucinates, turns 4-20 build on it. The hallucination becomes load-bearing context.
- There is no way to verify, compare, or contradict a specific claim — it's buried in a wall of text.
- Nothing forces synthesis. Messages just accumulate.
- The context window fills with noise. Relevant information from turn 2 gets pushed out by irrelevant information from turn 18.
- There is no learning. Session 50 has the same cold-start problem as session 1.

Every existing system (Mem0, Zep, Graphiti, LangMem) bolts a graph onto this broken foundation. They extract entities from chat history and store them in a graph, but the chat history remains the primary context sent to the LLM. The graph is supplementary. The broken foundation stays.

Composia replaces the foundation. The session graph is the constructed context; the global graph influences it indirectly by proposing candidates. Chat messages are ephemeral proposals that get decomposed into graph mutations, approved by the user, and discarded. Only the graphs persist.

## Nodes

A node is a markdown file. It represents a discrete, verifiable unit of knowledge — a claim, a concept, a fact, a question, an answer.

A node is also a piece of **context-steering data**. It exists to influence the session graph when the LLM evaluates it as relevant. Every node is simultaneously content (readable information) and a potential influence (when this topic comes up, consider this).

### Visitors

A **visitor** is a node from the global graph that is proposed as a candidate for evaluation during a query. The global graph does not inject visitors into the session graph directly — it proposes them. The LLM evaluates each visitor's summary and decides whether to accept it. Accepted visitors have their content loaded and decomposed into nodes and edges within the session graph — they are not inserted as raw text. They influence the constructed context through structured decomposition, the same way any other input is processed. Rejected visitors are ignored.

The term "visitor" is used throughout this document to distinguish proposed candidates from nodes that are already part of the session graph.

In practice, most proposed visitors are rejected. The system is selective by design.

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

**Forward links** are like function calls. They say: "this node references that node." When a node is proposed as a visitor, its forward links identify other nodes that may also be proposed — but none are automatically included. The LLM evaluates each one.

**Backlinks** signal historical influence. They indicate that node B has historically influenced node A. When B is accepted into the session graph, its relationship to A may influence how A is interpreted — but only through LLM evaluation, not automatic propagation. Backlinks are candidates for context influence, not guaranteed flows.

**Weight** is purely repetition count. If the edge `auth → jwt` has appeared in 22 sessions, its weight is 22. Higher weight increases the likelihood that the connection is proposed as a candidate during context assembly. But weight does not guarantee inclusion — the LLM evaluates whether to accept the proposal. No rules, no automatic traversal. Just counting how many times the connection appeared.

**Edges do not imply relevance.** An edge only encodes co-occurrence — that two concepts appeared together repeatedly. It does not mean "this is relevant to the current answer." The LLM decides relevance. The edge only says "these concepts have been connected before, consider whether they should be connected now."

Edges can span multiple hops. The path `auth → jwt → api-gateway → rate-limiting → redis` might never have been explicitly stated anywhere, but each individual edge was reinforced independently across different sessions. Whether the system follows that path in a given session depends on the LLM evaluating each hop — it is not automatic.

### Edge reinforcement is independent of node consolidation

A node can consolidate (merge its content with similar nodes) without affecting any edges. An edge can be reinforced (increase its weight) without any node consolidating. Both processes are driven by repetition, but they operate independently.

## Two Graphs

### Session Graph (short-term)

Built fresh when a session starts. Every user prompt and LLM response during the session is decomposed into nodes and edges that get added to this graph.

The session graph grows throughout the interaction. New connections are discovered. Edges between session nodes get reinforced within the session as topics recur. The session graph is the working memory — it represents what is being discussed right now.

At session end, the session graph is compared against the global graph. Matches are logged. If any node hits the consolidation threshold, consolidation is triggered. Reinforced edges update the global graph's edge weights.

The session graph is ephemeral. It does not persist after the session ends. Its contribution to the global graph (via matches and reinforcement) is what persists.

### Global Graph (long-term)

Persistent across all sessions. The global graph is a **learned prior** — it encodes what concepts exist, how they've been connected historically, and how strongly those connections have been reinforced. It does not produce answers. It biases which concepts the session graph considers.

At session start, the global graph is available for the system to draw visitors from. The system proposes candidate nodes as visitors based on vector similarity and graph structure; the LLM evaluates them. It does not receive the full content of every node — it receives the graph structure and summaries, then the system proposes specific nodes as visitors to the session graph based on similarity to the current input.

The global graph grows denser over time. Nodes that represent the same concept across multiple sessions get consolidated into single, canonical nodes. Edges that appear repeatedly get heavier. Nodes and edges that are never reinforced decay and eventually get pruned.

The global graph is how the system learns. After processing 10 books on distributed systems, the graph has heavy, dense nodes for consensus, replication, and partitioning — because every book mentions them. Niche ideas from one book stay low-weight. But even a heavy node is only a strong candidate — it still requires LLM evaluation before it influences a session.

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

Independent of consolidation. Every time an edge appears in a session, its weight in the global graph increments by 1. If `payments → idempotency` appears in 15 sessions, that edge has weight 15. Higher weight increases the likelihood that the connection is proposed during context assembly — but the LLM evaluates each one.

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

## Context Steering vs Answer Generation

These are two distinct operations:

**Context steering** is the process of building and evolving the session graph. The global graph influences this by proposing visitors. The LLM evaluates visitors. Accepted visitors become part of the session graph and influence subsequent iterations. Context steering is how the session graph grows and connects.

**Answer generation** is the final synthesis from the converged session graph. Only the session graph produces the answer. The global graph's role is over — it influenced which visitors were proposed, but the answer is synthesized from what the session graph contains.

The global graph steers context. The session graph generates answers. They do not overlap.

**The global graph influences what the system considers; the session graph determines what the system ultimately uses.**

## The Query Loop: Convergence-Based Answering

When a user asks a question, the system does not produce an immediate answer. It iterates until the session graph converges — until new iterations reinforce existing edges instead of discovering new ones.

### How a query is processed

**1. Decompose the prompt into a session graph**

The user's prompt is not text to pass to an LLM. It is a graph with missing nodes — a question structure.

```
User: "How should I handle auth in this microservice?"

Decomposed into session graph:
  Node: "auth" (concept, needs resolution)
  Node: "microservice" (context constraint)
  Edge: auth → microservice (scoped: "auth IN this microservice")
  Type: "how" (seeking approach/pattern)
```

**2. Generate visitors from the global graph**

The system uses vector similarity to find nodes in the global graph that match the session graph's nodes. These are **visitors** — candidates proposed for evaluation, not answers.

```
Visitors proposed:
  auth-node       weight: 47 (strong candidate)
  jwt-node        weight: 32 (strong candidate)
  api-gateway     weight: 28 (strong candidate)
  sessions-node   weight: 3  (weak candidate)
```

High-weight visitors are proposed first, but weight does not guarantee acceptance. Edges between visitors in the global graph may cause additional visitors to be proposed (e.g., jwt's edge to api-gateway proposes api-gateway as a visitor). But no visitor is automatically included.

**3. LLM evaluates which visitors to accept**

The LLM receives the visitor summaries and the current session graph. It decides which visitors are useful for the current reasoning. This is not automatic traversal — it is LLM-mediated selection.

```
LLM evaluation:
  auth-node       → ACCEPT (directly relevant)
  jwt-node        → ACCEPT (likely approach)
  api-gateway     → ACCEPT (context constraint)
  sessions-node   → REJECT (not relevant to this microservice)
```

**4. Accepted visitors influence the session graph**

The content of accepted visitors is loaded. New nodes and edges are added to the session graph based on what the visitor content contains. The session graph grows.

The session graph now contains the decomposed prompt AND the accepted visitor content, connected by edges. This is the constructed context.

**5. LLM produces output from the session graph**

The LLM responds based on context assembled from the session graph — not from the global graph, not from chat history. Only the session graph.

**6. Decompose the output into the session graph**

The LLM's response is decomposed. New nodes and edges are added to the session graph. Possibly a new concept emerged: `jwt → rate-limiting` (the LLM mentioned this relationship).

**7. Generate new visitors from the enriched session graph**

With the session graph now larger, new vectors from new nodes trigger new visitor proposals from the global graph. Nodes that weren't candidates before may now be proposed because of the new edges.

**8. LLM evaluates new visitors**

Same as step 3. The LLM decides which new visitors to accept.

**9. Repeat until convergence**

The loop continues:
1. Build/expand session graph
2. Generate visitors from global graph
3. LLM evaluates which visitors to accept
4. Accepted visitors influence next iteration of the session graph
5. Repeat

**10. Detect convergence**

The system monitors whether new iterations are producing new nodes/edges in the session graph or just reinforcing existing ones. When the session graph stabilizes — new visitors are rejected because the session graph already contains equivalent knowledge — the system has converged. Convergence occurs when proposed visitors no longer introduce new structure into the session graph.

Convergence = confidence. The answer is ready.

**11. Produce answer from the session graph**

The system synthesizes a final output from the converged session graph and presents it to the user. The answer is a product of the session graph only.

```
Convergence:
  Iteration 1: 8 new nodes, 12 new edges (session graph growing)
  Iteration 2: 4 new nodes, 6 new edges, 3 reinforced (slowing)
  Iteration 3: 1 new node, 2 new edges, 8 reinforced (stabilizing)
  Iteration 4: 0 new nodes, 0 new edges, all visitors rejected (converged)
  → CONVERGED → synthesize answer from session graph
```

A well-known topic (heavy visitor candidates, strong proposals) converges in 1-2 iterations. A novel or complex question takes more loops. The system self-regulates — it doesn't have a fixed number of steps.

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

**Not a RAG system.** RAG retrieves chunks and stuffs them into the context window alongside the conversation. In Composia, the global graph does not supply answer content — it proposes visitors that the LLM evaluates. The session graph constructs the context. There is no "retrieve and stuff." There is "propose, evaluate, accept, construct."

**Not a knowledge base you query separately.** Neo4j, Obsidian, and traditional knowledge graphs are databases you query from an application. Composia is in the LLM call path — it preprocesses every prompt and postprocesses every response. It's not a tool the LLM calls; it's the layer the LLM runs on.

**Not a note-taking app.** Obsidian is for humans writing personal notes. Composia is a context compiler. The markdown files are a serialization format for graph nodes, not documents for humans to browse.

## How It Differs From Everything Else

| System | Context source | Graph role | Learning | Quality gate |
|---|---|---|---|---|
| Standard LLM | Chat history | None | None | None |
| RAG | Chat history + retrieved chunks | Retrieval store (supplies content directly) | None | None |
| Mem0 / Zep | Chat history + graph memories | Supplementary retrieval | Entity extraction (one-shot) | None (silent) |
| Graphiti | Chat history + temporal graph | Supplementary retrieval | Incremental entity extraction | None (silent) |
| Graph of Thoughts | Ephemeral per-query graph | Primary but ephemeral | None (rebuilt each time) | None |
| **Composia** | **Session graph (no chat history)** | **Global = learned prior (proposes visitors); Session = constructed context (produces answers)** | **Hebbian (reinforcement + consolidation)** | **Human approval** |

The row that matters: Composia is the only system where the graph is split into prior (global) and context (session), where the global graph proposes rather than retrieves, where the system learns through reinforcement, and where a human approves every mutation.

## The Core Mechanism in One Sentence

Every input is decomposed into graph nodes and edges; the global graph proposes visitors that the LLM evaluates for inclusion in the session graph; repeated nodes consolidate into abstractions while preserving all edges; repeated edges get reinforced; answers are synthesized only from the converged session graph; the system converges toward truth because truth is reinforced and hallucinations are not.

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
