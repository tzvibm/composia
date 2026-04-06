# CLAUDE.md

## Project Overview

Composia is an embedded graph-backed knowledge base for AI agents. It stores notes and relationships in RocksDB, providing instant graph traversal at scale — the "SQLite of knowledge graphs."

Agents and developers use it to build persistent, traversable project memory that grows with every session. Markdown files in `.composia/kb/` are the source of truth (committed to git). RocksDB indexes are built locally — like `node_modules` from `package.json`.

## Commands

```bash
npm test               # Run all tests (Vitest)
npm run test:watch     # Run tests in watch mode

# Setup & Sync
composia init                              # Set up Composia in a project
composia build                             # Build RocksDB from kb/ files (run after git pull)
composia sync                              # Write MCP/hook-created notes back to kb/

# Knowledge
composia remember "chose RocksDB because [[embedded]] #architecture"
composia recall "What did we decide about auth?"  # LLM-powered query
composia context <note-id>

# Notes
composia note add <id> -t "Title" -c "Content with [[links]]"
composia note get <id>
composia note list
composia note rm <id>

# Graph
composia link from <id>
composia link to <id>
composia link graph <id> --depth 2

# Search & Query
composia search <query>
composia tag <tag>
composia query <field> <value>             # Indexed property query
composia field <field>                     # Show all values for a field

# Rules & Triggers
composia rules add "When changing auth, update security audit"
composia rules list
composia trigger add <id> --field status --op eq --value blocked --action tag --tag needs-attention

# Temporal
composia history <id>                      # Version history
composia changes --since <timestamp>       # Recent activity
composia snapshot <label>                  # Save context before compaction

# Stats
composia stats
```

## Architecture

**Stack:** Node.js + RocksDB (classic-level) — pure JavaScript, zero native build step.

```
CLI (commander)     →  Knowledge Service  →  Engine  →  RocksDB (classic-level)
MCP Server (mcp.js)    knowledge.js          engine.js   ├── notes sublevel
Hooks (hooks.js)       parser.js             sync.js     ├── links sublevel
                                                         ├── backlinks sublevel
                                                         ├── tags sublevel
                                                         ├── propidx sublevel
                                                         ├── history sublevel
                                                         └── triggers sublevel
```

### Core Files

- **`src/engine.js`** — RocksDB wrapper: notes, links, backlinks, tags, property indexes, history, triggers
- **`src/parser.js`** — Parses `[[wikilinks]]`, `#tags`, YAML frontmatter, templates
- **`src/knowledge.js`** — High-level service: CRUD, link/tag sync, property queries, temporal, triggers
- **`src/sync.js`** — Bidirectional sync: kb/ markdown ↔ RocksDB
- **`src/cli.js`** — CLI interface (commander)
- **`src/resolve.js`** — LLM-powered query resolution (natural language → multi-step graph queries → synthesized answer)
- **`src/summarizer.js`** — Two-layer summaries: deterministic (instant) + LLM-generated (semantic)
- **`src/schema.js`** — Property schema enforcement, alias normalization
- **`src/mcp.js`** — MCP server exposing 15 tools for Claude Code integration
- **`src/hooks.js`** — Session hooks: auto-capture (post) + auto-traverse (pre) + rules
- **`src/init.js`** — Project setup: creates `.composia/` structure

### Key Concepts

**Notes**: `{ id, title, content, tags[], properties{}, created, updated }` in the notes sublevel.

**Links**: `[[target-id]]` in content auto-syncs to links/backlinks sublevels on every save.

**Properties**: YAML frontmatter parsed and stored. Indexed in propidx sublevel for instant queries.

**History**: Every save creates a versioned snapshot in the history sublevel. Time-travel queries.

**Triggers**: Rules that fire when property conditions are met (auto-tag, auto-link, log).

**Rules**: Plain English directives stored as notes tagged #rules. Surfaced to Claude via hooks.

### Team Workflow (git-native)

```
.composia/kb/          ← IN GIT (markdown files, diffable, small)
.composia/db/          ← GITIGNORED (RocksDB, rebuilt locally)
```

1. Developer writes notes in `kb/` or uses `composia remember`
2. `git commit && git push`
3. Teammate: `git pull && composia build`
4. After MCP/hook writes: `composia sync` to write back to `kb/`

### Database

RocksDB via `classic-level`, stored in `.composia/db/` (gitignored):
- `notes` — note payloads with properties
- `links` — forward links (source:target → context)
- `backlinks` — reverse links (target:source)
- `tags` — tag index (tag:noteId)
- `propidx` — property index (field:value:noteId)
- `history` — temporal snapshots (noteId:timestamp → snapshot)
- `triggers` — reactive rules (triggerId → config)
