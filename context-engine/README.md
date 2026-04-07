# Context Engine MVP

Wiki-as-context for Claude Code. No wrappers, no API calls, no infrastructure.

## How it works

1. Claude Code maintains a wiki of markdown files (`.composia/wiki/`)
2. The wiki IS the context — structured, cross-referenced, evolving
3. Between turns, `/clear` wipes chat history
4. Next turn: Claude Code reads the wiki, has full structured context, zero chat accumulation

The CLAUDE.md schema instructs Claude to:
- Read the wiki at the start of each turn
- Update wiki pages based on the conversation
- Cross-reference between pages
- Use the wiki as its primary knowledge source

## Setup

```bash
# Initialize the wiki
node context-engine/init.js

# That's it. Start using Claude Code normally.
# The CLAUDE.md schema handles everything.
```

## The loop

```
Turn 1: user asks something
  → Claude reads wiki (empty at first)
  → Claude responds
  → Claude updates wiki pages with new knowledge
  → User runs /clear

Turn 2: user asks something else
  → Claude reads wiki (now has pages from turn 1)
  → Claude responds using wiki context (not chat history)
  → Claude updates wiki
  → /clear

Turn N: wiki is dense with structured knowledge
  → Claude reads wiki, has full context of everything discussed
  → No chat history needed
  → No hallucination accumulation
```

## Files

```
context-engine/
├── init.js       # Initialize wiki structure
├── wiki.js       # Wiki operations (used by init, available for scripts)
└── schema.md     # Wiki maintenance schema

.composia/wiki/   # The wiki (created by init.js)
├── schema.md     # How to maintain the wiki
├── index.md      # Page catalog
├── log.md        # Change log
└── pages/        # Knowledge pages
```
