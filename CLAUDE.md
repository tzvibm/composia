# CLAUDE.md

## Project Overview

Composia is an embedded graph-backed knowledge base for AI agents. It stores notes and relationships in RocksDB, providing instant graph traversal at scale — the "SQLite of knowledge graphs."

Agents and developers use it to build persistent, traversable project memory that grows with every session.

## Commands

```bash
npm test               # Run all tests (Vitest)
npm run test:watch     # Run tests in watch mode

# CLI
composia init                              # Set up Composia in a project
composia remember "chose RocksDB because [[embedded]] #architecture"
composia recall "auth patterns"
composia context <note-id>
composia note add <id> -t "Title" -c "Content with [[links]]"
composia note get <id>
composia note list
composia note rm <id>
composia link from <id>
composia link to <id>
composia link graph <id> --depth 2
composia search <query>
composia tag <tag>
composia stats
composia export > snapshot.json
composia import snapshot.json
composia ingest [dir]                      # Ingest .md files from folder
```

## Architecture

**Stack:** Node.js + RocksDB (classic-level) — pure JavaScript, zero native build step.

```
CLI (commander)     →  Knowledge Service  →  Engine  →  RocksDB (classic-level)
MCP Server (mcp.js)    knowledge.js          engine.js   ├── notes sublevel
Hooks (hooks.js)       parser.js                         ├── links sublevel
                                                         ├── backlinks sublevel
                                                         └── tags sublevel
```

### Core Files

- **`src/engine.js`** — RocksDB wrapper with sublevels for notes, links, backlinks, tags
- **`src/parser.js`** — Parses `[[wikilinks]]` and `#tags` from markdown content
- **`src/knowledge.js`** — High-level service: note CRUD with automatic link/tag syncing
- **`src/cli.js`** — CLI interface (commander)
- **`src/mcp.js`** — MCP server exposing 7 tools for Claude Code integration
- **`src/hooks.js`** — Session hooks: auto-capture (post) + auto-traverse (pre)
- **`src/init.js`** — Project setup: creates `.composia/` structure

### Key Concepts

**Notes**: Stored as `{ id, title, content, tags[], created, updated }` in the notes sublevel.

**Links**: When a note contains `[[target-id]]`, the engine stores:
- Forward link: `links/source:target → { context }`
- Backlink: `backlinks/target:source → {}`
Links are synced automatically on every save.

**Tags**: Parsed from `#tag` in content. Stored in `tags/tagname:noteid`.

**Graph Traversal**: `getNeighbors(id, depth)` does BFS traversal via forward links and backlinks.

### Integration

**MCP Server** — 7 tools: `composia_save`, `composia_get`, `composia_search`, `composia_links`, `composia_graph`, `composia_list`, `composia_delete`

**Session Hooks** — `hooks.js pre` surfaces relevant context before edits. `hooks.js post` captures session activity.

**Export/Import** — JSON snapshots for team sharing via git.

**Markdown Ingestion** — `composia ingest` reads `.composia/kb/` folder of .md files into the graph.

### Database

RocksDB via `classic-level`, stored in `.composia/db/` (gitignored):
- `notes` sublevel — note payloads
- `links` sublevel — forward links (source:target → context)
- `backlinks` sublevel — reverse links (target:source → {})
- `tags` sublevel — tag index (tag:noteId → {})
