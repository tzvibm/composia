# Composia: Context Engine v2

## What This Is

A 13-step graph pipeline that replaces chat history with graph-constructed context. Every input is decomposed into atomic semantic elements (nodes), connected by typed weighted edges, stored with vector embeddings for RAG retrieval, and resynthesized through a confidence-based traversal loop.

## Architecture

Pure Python + SQLite. One database for graph storage and vector embeddings.

```
context_engine/
├── models.py          # Node, Edge, TraversalTuple, ChangeSet
├── config.py          # Thresholds, model names, decay params
├── llm_client.py      # Anthropic API wrapper
├── graph_store.py     # SQLite graph: nodes, edges, tags, history
├── vector_store.py    # FastEmbed + numpy cosine similarity
├── decomposer.py      # Steps 1-3: text → nodes → edges
├── retriever.py       # Steps 4-7: RAG + confidence traversal
├── resynthesizer.py   # Steps 8-9: graph mutations + approval
├── prompt_template.py # Steps 10-11: deterministic rendering
├── pipeline.py        # Steps 1-13: orchestrator + REPL
└── bench_adapter.py   # Benchmark integration
```

## The 13-Step Pipeline

```
User input
  ↓
1. LLM decomposes into nodes (no edges)
2. LLM generates typed edges between nodes
3. Store as prompt graph + embed in vector store
  ↓
4. Index prompt nodes for RAG
5. Find similar session nodes via vector search
6. Build (prompt, session) tuples with edges + similarity scores
7. Confidence traversal: LLM decides if more context needed, follows edges
  ↓
8. LLM proposes graph mutations (resynthesize, correct, delete, new edges, etc.)
9. Show summary → user approves → apply changes
  ↓
10. Render session graph (deterministic template)
11. Render prompt graph (deterministic template)
12. Stateless LLM call with graph-constructed prompt
13. Decompose response → repeat from step 1
```

## Three Graph Layers

- **prompt**: Current turn's decomposed input. Cleared after each turn.
- **session**: Accumulated session context. Grows with each turn.
- **system**: Long-term cross-session memory (future).

## Running

```bash
pip install anthropic fastembed numpy python-dotenv

# Interactive REPL
python -m context_engine.pipeline

# Set API key
export ANTHROPIC_API_KEY=your-key
# Or use .env file
```

## Dependencies

- anthropic (LLM API)
- fastembed (local embeddings, BAAI/bge-small-en-v1.5)
- numpy (vector similarity)
- python-dotenv (env loading)
- sqlite3 (stdlib, graph + vector storage)
