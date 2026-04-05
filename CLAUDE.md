# CLAUDE.md

## Project Overview

Composia is a graph-backed knowledge base for agents. It stores notes and their relationships (links) in RocksDB, providing instant graph traversal that scales to millions of notes — unlike file-based tools (Obsidian) that must reparse all files to build the graph.

## Commands

```bash
npm start              # Start web UI (port 3000)
npm run dev            # Same as start
npm test               # Run all tests (Vitest)
npm run test:watch     # Run tests in watch mode
node src/cli.js serve  # Start web UI with --port option
node src/cli.js note add <id> -t "Title" -c "Content with [[links]]"
node src/cli.js note get <id>
node src/cli.js note list
node src/cli.js note rm <id>
node src/cli.js link from <id>
node src/cli.js link to <id>
node src/cli.js link graph <id> --depth 2
node src/cli.js search <query>
node src/cli.js tag <tag>
node src/cli.js stats
```

## Architecture

**Stack:** Node.js + RocksDB (classic-level) — pure JavaScript, no native build step.

```
CLI (commander)  →  Knowledge Service  →  Engine  →  RocksDB (classic-level)
Web UI (vanilla)     knowledge.js         engine.js   ├── notes sublevel
server.js + ui.html  parser.js                        ├── links sublevel
                                                      ├── backlinks sublevel
                                                      └── tags sublevel
```

### Core Files

- **`src/engine.js`** — RocksDB wrapper with sublevels for notes, links, backlinks, tags
- **`src/parser.js`** — Parses `[[wikilinks]]` and `#tags` from markdown content
- **`src/knowledge.js`** — High-level service: note CRUD with automatic link/tag syncing
- **`src/cli.js`** — CLI interface (commander)
- **`src/server.js`** — Lightweight HTTP API server
- **`src/ui.html`** — Single-page web UI with force-directed graph visualization

### Key Concepts

**Notes**: Stored as `{ id, title, content, tags[], created, updated }` in the notes sublevel.

**Links**: When a note contains `[[target-id]]`, the engine stores:
- Forward link: `links/source:target → { context }`
- Backlink: `backlinks/target:source → {}`
Links are synced automatically on every save — no manual link management.

**Tags**: Parsed from `#tag` in content. Also synced automatically. Stored in `tags/tagname:noteid`.

**Graph Traversal**: `getNeighbors(id, depth)` does BFS traversal using forward links and backlinks.

### Database

RocksDB via `classic-level`, stored in `.composia/` by default:
- `notes` sublevel — note payloads
- `links` sublevel — forward links (source:target → context)
- `backlinks` sublevel — reverse links (target:source → {})
- `tags` sublevel — tag index (tag:noteId → {})
