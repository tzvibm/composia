# Composia

Context engine that replaces chat history with wiki-constructed context.

## The idea

Every LLM system uses chat history as context. Chat history is an append-only log — hallucinations compound, corrections get buried, irrelevant turns waste tokens.

Composia assembles context from a structured wiki instead. Each turn: decompose input into wiki pages, build a focused prompt from the wiki, make a fresh API call with zero chat history, decompose the response back into wiki pages.

## Quick start

```bash
pip install anthropic
export ANTHROPIC_API_KEY=your-key
cd mvp && python3 agent.py
```

## Benchmarks

```bash
# LoCoMo (industry standard — Mem0 scores 66.9% on this)
git clone https://github.com/snap-research/locomo /tmp/locomo
python3 bench_locomo.py

# LongMemEval (ICLR 2025 — GPT-4o scores ~45% on this)
git clone https://github.com/xiaowu0162/LongMemEval /tmp/longmemeval
python3 bench_longmemeval.py
```

## Status

MVP / proof of concept. Testing whether wiki-as-context beats chat history on standard benchmarks.
