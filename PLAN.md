# Composia Context Engine v2 — Implementation Plan

## Context

The current MVP (`mvp/`) is a flat wiki with LLM-based decomposition and relevance finding. Benchmarks show it works (~73% F1 on LoCoMo, matching published scores) but has fundamental limitations: no RAG, no structured graph traversal, no confidence-based retrieval, no human approval loop, and the LLM paraphrases during decomposition. The user designed a 13-step pipeline that addresses all of these.

## Architecture: Pure Python + SQLite

**One SQLite database** for both graph storage and vector search (via sqlite-vec extension). No Node.js, no RocksDB, no separate processes.

- **FastEmbed** (`BAAI/bge-small-en-v1.5`, 384 dims) for local embeddings (~5ms/doc)
- **sqlite-vec** for KNN vector search (<10ms)
- **Anthropic API** for decomposition, edge generation, traversal, and resynthesis

## Three Graph Layers

All in one `nodes` table, separated by `layer` column:

| Layer | Purpose | Lifetime |
|-------|---------|----------|
| `prompt` | Current turn's decomposed input | Cleared after each turn (promoted parts move to session) |
| `session` | Full session context | Lives for entire conversation |
| `system` | Long-term memory | Persists across sessions (implemented later) |

## Directory Structure

```
composia/
  context_engine/
    __init__.py
    models.py              # Node, Edge, TraversalTuple, ChangeSet dataclasses
    config.py              # Constants: thresholds, model names, decay params
    llm_client.py          # Thin Anthropic API wrapper
    graph_store.py          # SQLite graph: nodes, edges, tags, history tables
    vector_store.py         # FastEmbed + sqlite-vec (shares same SQLite connection)
    decomposer.py           # Steps 1-3: text → nodes (no edges) → edges
    retriever.py            # Steps 4-7: RAG search + confidence traversal loop
    resynthesizer.py        # Steps 8-9: propose graph mutations + approval
    prompt_template.py      # Steps 10-11: deterministic graph → prompt rendering
    pipeline.py             # Steps 1-13: full orchestrator
    bench_adapter.py        # Adapter for LoCoMo/BABILong benchmarks
```

## SQLite Schema

```sql
CREATE TABLE nodes (
    id TEXT PRIMARY KEY,
    layer TEXT NOT NULL CHECK(layer IN ('system', 'session', 'prompt')),
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    summary TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',    -- JSON array
    properties TEXT DEFAULT '{}',       -- JSON object
    weight REAL DEFAULT 1.0,
    confidence REAL DEFAULT 1.0,
    access_count INTEGER DEFAULT 0,
    created TEXT NOT NULL,
    updated TEXT NOT NULL,
    last_accessed TEXT NOT NULL,
    supersedes TEXT
);
CREATE INDEX idx_nodes_layer ON nodes(layer);

CREATE TABLE edges (
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    weight REAL DEFAULT 1.0,
    edge_type TEXT DEFAULT '',
    context TEXT DEFAULT '',
    last_seen TEXT NOT NULL,
    PRIMARY KEY (source_id, target_id)
);
CREATE INDEX idx_edges_target ON edges(target_id);

CREATE TABLE tags (
    tag TEXT NOT NULL,
    node_id TEXT NOT NULL,
    PRIMARY KEY (tag, node_id)
);

CREATE TABLE history (
    node_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    PRIMARY KEY (node_id, timestamp)
);

-- sqlite-vec virtual table (same DB connection)
CREATE VIRTUAL TABLE vec_nodes USING vec0(
    id TEXT PRIMARY KEY,
    embedding float[384]
);
```

## The 13 Steps

### Steps 1-3: Decomposition (`decomposer.py`)

1. **LLM call → nodes only**: Given raw text, extract atomic semantic elements (fact, event, feeling, decision, temporal, etc.) as nodes. NO edges in this step. Preserve exact wording, convert relative dates to absolute.
2. **LLM call → edges**: Given the extracted nodes, generate directed edges between them with types (causes, relates_to, contradicts, temporal_sequence, etc.)
3. **Store**: Write nodes to `prompt` layer, write edges, embed in sqlite-vec.

### Steps 4-7: Retrieval (`retriever.py`)

4. **Index**: Embed prompt graph nodes in sqlite-vec (already done in step 3)
5. **RAG search**: For each prompt node, find top-K similar session nodes by vector similarity
6. **Build tuples**: Pair each (prompt node, session node) with their immediate edges, summaries, and similarity scores
7. **Confidence traversal loop**: Ask LLM "do you have enough context?" with confidence score. If below threshold (default 0.7), follow edges the LLM suggests. Max 3 iterations.

### Steps 8-9: Resynthesis (`resynthesizer.py`)

8. **LLM proposes changes**: Given tuples + edges, the LLM scores which to resynthesize, correct, add content, update summaries, delete, add/remove edges. Returns a ChangeSet with human-readable summary.
9. **Approval**: Show user the summary. If approved, apply changes (promote prompt nodes to session, execute mutations). If rejected with new input, restart from step 1. `auto_approve=True` for benchmarks.

### Steps 10-11: Prompt Template (`prompt_template.py`)

Deterministic, lossless, no LLM call. Template format:

```
== SESSION CONTEXT ({N} nodes, {M} edges) ==

[NODE INDEX]
@{id} [{tags}] w={weight} c={confidence}
  {summary}
  → @{target1} (w={w1}), → @{target2} (w={w2})
  ← @{source1} (w={w1})

[NODE CONTENT]
--- @{id}: {title} ---
{full content}

== CURRENT INPUT ({N} nodes) ==

[NODE INDEX]
@{id} [{tags}] NEW
  {summary}
  SIMILAR: @{session_node} ({score})

[NODE CONTENT]
--- @{id}: {title} ---
{full content}
```

### Steps 12-13: Send & Process (`pipeline.py`)

12. **Stateless API call**: System prompt = rendered template. User message = original input. Temperature=0, appropriate max_tokens.
13. **Process response**: Run steps 1-9 on the LLM response (decompose response → find similar → resynthesize → approve). Then ready for next turn.

## Implementation Phases

### Phase 1: Foundation
Files: `models.py`, `config.py`, `llm_client.py`, `graph_store.py`
- Dataclasses, SQLite schema, CRUD operations, decay/reinforcement
- Zero LLM calls. Unit testable.

### Phase 2: RAG Layer
File: `vector_store.py`
- FastEmbed init, sqlite-vec virtual table, embed + search
- Shares SQLite connection with graph_store
- `pip install fastembed sqlite-vec`

### Phase 3: Decomposition
File: `decomposer.py`
- Port the decomposition prompt from `mvp/wiki_updater.py` (split into two calls: nodes-only, then edges)
- First LLM integration point

### Phase 4: Retrieval + Traversal
File: `retriever.py`
- Vector search, tuple building, confidence loop
- Second LLM integration point (confidence scoring)

### Phase 5: Resynthesis + Template
Files: `resynthesizer.py`, `prompt_template.py`
- Change proposals, approval flow, deterministic rendering

### Phase 6: Pipeline + Benchmarks
Files: `pipeline.py`, `bench_adapter.py`
- Wire all steps together
- Run LoCoMo and BABILong against the new engine

## What to Reuse from MVP

- **Decomposition prompt** (`mvp/wiki_updater.py:15-59`): Semantic element types, no-paraphrase rules, date conversion. Split into two calls.
- **Decay math** (`mvp/wiki.py:140-155`): Exponential decay, half-life, reinforcement amounts.
- **Benchmark scoring** (`mvp/bench_locomo.py`, `mvp/bench_babilong.py`): Use existing harnesses, swap system-under-test.

## What NOT to Port

- Node.js engine triggers/hooks — not needed
- Node.js schema normalization — fixed schema in context engine
- Node.js sync.js — SQLite is source of truth, no markdown sync
- Current `prompt_builder.py` LLM-based relevance — replaced by RAG

## Verification

1. **Unit tests**: graph_store CRUD, vector_store embed+search, decay math
2. **Integration test**: Full 13-step pipeline on a 5-turn conversation
3. **LoCoMo benchmark**: Run bench_locomo.py with bench_adapter swapped in. Target: match or beat 73% F1.
4. **BABILong benchmark**: Run bench_babilong.py. Target: maintain accuracy at 4k+ contexts where MVP struggled.
5. **Interactive test**: `python -m context_engine.pipeline` REPL — chat, inspect graph, verify approval flow
