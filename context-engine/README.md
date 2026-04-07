# Context Engine MVP

Proof of concept: wiki-as-context replaces chat history.

Based on Karpathy's LLM wiki pattern, adapted so the wiki IS the LLM's context — not a separate knowledge base the LLM queries.

## How it works

```
User input
    ↓
Context Builder (Claude Code / LLM call)
    → reads wiki (index.md + relevant pages)
    → decomposes input into wiki updates
    → creates/updates pages, cross-references, index
    ↓
Updated wiki = the context
    ↓
Reasoning LLM (fresh API call, zero chat history)
    → receives wiki content as system context
    → produces response
    ↓
Context Builder
    → decomposes response into wiki updates
    → wiki grows with each turn
    ↓
Next turn (repeat)
```

## Quick start

```bash
# Initialize a wiki
node context-engine/init.js

# Run the interactive loop
node context-engine/loop.js

# Or run in benchmark mode against chat history
node context-engine/bench.js
```

## File structure

```
context-engine/
├── init.js          # Initialize wiki with schema + index
├── loop.js          # Interactive loop: input → update wiki → reason → update wiki
├── bench.js         # Benchmark: wiki-context vs chat-history on same questions
├── wiki.js          # Wiki operations: read, update, search index
├── context.js       # Build context from wiki for the reasoning LLM
└── schema.md        # The Karpathy schema: how the wiki should be maintained
```

## Wiki structure (created by init.js)

```
.composia/wiki/
├── schema.md        # Instructions for wiki maintenance
├── index.md         # Catalog of all pages with summaries
├── log.md           # Chronological record of updates
└── pages/           # Knowledge pages (created during interaction)
```
