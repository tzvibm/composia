# Composia: Context Engine MVP

## What This Is

A proof of concept that replaces chat history with wiki-constructed context.

Every existing LLM system uses chat history as context — an append-only log where hallucinations compound, irrelevant turns waste tokens, and nothing is learned across sessions. Composia tests a different approach: the LLM's context is assembled from a structured wiki that grows with each turn.

## The Core Loop

```
User sends message
    ↓
1. DECOMPOSE: Haiku extracts knowledge from user input → updates wiki pages
    ↓
2. BUILD CONTEXT: Haiku selects relevant pages, extracts relevant portions,
   describes connections in English → assembles into a structured prompt
    ↓
3. REASON: Sonnet receives wiki-assembled prompt (NOT chat history) +
   user message as a fresh API call → produces response
    ↓
4. DECOMPOSE: Haiku extracts knowledge from response → updates wiki pages
    ↓
Next turn (wiki is richer, context is better)
```

Each turn is a **fresh API call with zero chat history**. The wiki is the only context. It grows and improves with every turn.

## How the Prompt Is Built

The wiki is NOT dumped as raw text. It is assembled into a structured prompt:

1. **All nodes as one-line summaries** — full wiki awareness, lightweight
2. **Relevant nodes selected** — Haiku picks which pages matter for this turn
3. **Relevant portions extracted** — only the parts of each page that matter for THIS question (not full page dumps)
4. **Connections described in English** — "jwt-auth connects to api-gateway because tokens are validated at the gateway before routing"

This gives the reasoning LLM: broad awareness (summaries), focused depth (extracts), and steering (connections).

## Why This Might Work Better Than Chat History

- **Hallucinations don't compound** — each turn's context is built fresh from verified wiki pages, not from an ever-growing log that carries forward errors
- **Corrections stick** — when the user corrects something, the wiki page is updated; future turns see the corrected version, not the original mistake buried 50 turns back
- **Context is focused** — only relevant wiki content is included, not every turn that ever happened
- **Knowledge accumulates** — the wiki grows richer over time; turn 100 has better context than turn 1

## Files

```
mvp/
├── agent.py            # The loop: decompose → build → reason → decompose
├── wiki.py             # Page/Wiki classes, markdown read/write, [[link]] extraction
├── prompt_builder.py   # Assembles wiki into structured context prompt
├── wiki_updater.py     # Decomposes text into wiki page creates/updates
├── bench.py            # Custom quick tests (fact retention, corrections, cross-refs)
├── bench_locomo.py     # LoCoMo benchmark (industry standard, used by Mem0/Zep)
└── bench_longmemeval.py # LongMemEval benchmark (ICLR 2025)
```

## Running

```bash
# Interactive conversation
cd mvp && python3 agent.py

# Industry benchmarks (need datasets cloned locally)
python3 bench_locomo.py      # LoCoMo: compare against Mem0 (66.9%), OpenAI (52.9%)
python3 bench_longmemeval.py # LongMemEval: compare against GPT-4o (~45%)
```

Requires: `pip install anthropic` and `ANTHROPIC_API_KEY` set.

## What We Are Testing

The hypothesis: **structured wiki context outperforms append-only chat history** on factual consistency, information retention, and correction handling — measured by industry-standard benchmarks (LoCoMo, LongMemEval) using their official evaluation methodology.

If it does, the next step is adding a persistent global graph with Hebbian reinforcement (repeated concepts get consolidated, repeated connections get weighted). But first, prove the basic premise works.
