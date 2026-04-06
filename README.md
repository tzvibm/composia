# Composia

Embedded graph-backed knowledge base for AI agents. The SQLite of knowledge graphs.

Composia gives AI agents persistent, traversable memory that lives in your repo. Notes are linked with `[[wikilinks]]`, relationships are indexed in RocksDB, and graph traversal is instant at any scale.

## Why

- **Embedded** — `npm install composia`. No server, no Docker, no infrastructure.
- **Fast** — 1.3ms backlinks at 1M notes. 90ms local graph traversal. 7ms cold startup.
- **Lightweight traversal** — Auto-generated summaries on every note. Agents scan the graph reading summaries, only fetch full content when needed. Obsidian requires parsing full file content to understand any note.
- **Agent-native** — MCP server, CLI, session hooks. Built for Claude Code, not browsers.
- **Git-native** — Markdown files in git, RocksDB built locally. Teams sync through git, not exports.
- **Obsidian-compatible** — Same `[[wikilink]]` syntax. Same markdown files.

## Quick Start

```bash
npm install composia
npx composia init
```

### Remember things

```bash
composia remember "We chose RocksDB because [[embedded-db]] requirements #architecture"
composia remember "Fixed auth bug in [[session-handler]] by adding [[refresh-token-rotation]] #bugfix"
```

Both writes go to RocksDB (for instant queries) and `.composia/kb/` (for git).

### Recall them

```bash
composia recall "auth"
composia context session-handler    # Shows note + all links + backlinks
composia link graph session-handler --depth 2
```

### Write markdown files directly

Put `.md` files in `.composia/kb/` with `[[wikilinks]]` between them:

```
.composia/
├── kb/                  ← IN GIT (source of truth)
│   ├── architecture/
│   │   ├── auth-system.md       # "Uses [[jwt-tokens]] with [[api-gateway]]"
│   │   └── database-choice.md   # "Chose [[rocksdb]] over [[neo4j]] because [[embedded-db]]"
│   ├── patterns/
│   │   └── error-handling.md
│   └── rules.md                 # Plain English rules Claude follows
└── db/                  ← GITIGNORED (rebuilt locally)
```

```bash
composia build    # Builds RocksDB from kb/ files (like npm install)
```

### Team workflow

```bash
# Developer A
composia remember "Auth now uses [[jwt-tokens]] #architecture"
git add .composia/kb/ && git commit && git push

# Developer B
git pull
composia build    # Rebuilds graph locally from the .md files
```

No JSON exports. No special sync tools. Just markdown in git.

### Use with Claude Code

Add to `.claude/settings.json`:

```json
{
  "mcpServers": {
    "composia": {
      "command": "node",
      "args": ["node_modules/composia/src/mcp.js"]
    }
  },
  "hooks": {
    "Stop": [{
      "command": "node node_modules/composia/src/hooks.js post",
      "description": "Capture session to Composia knowledge graph"
    }]
  }
}
```

Claude can now:
- **Read** the knowledge graph before making changes (surfaces relevant context)
- **Write** to it after sessions (captures what was done)
- **Traverse** links to understand relationships between concepts
- **Follow rules** you define in plain English

### Rules (plain English directives)

```bash
composia rules add "When changing auth files, always check the security audit note"
composia rules add "Always link bug fixes to the original issue note"
composia rules add "Tag any note about database changes with #migration"
```

Rules are stored in `.composia/kb/rules.md` (in git) and surfaced to Claude via hooks before every action.

### Property indexes (instant queries)

```bash
composia query status blocked          # All notes where status=blocked
composia query priority high           # All high-priority notes
composia field status                  # Show all unique status values
```

Properties come from YAML frontmatter:
```markdown
---
status: blocked
priority: high
assignee: alice
---
# Auth Refactor
This is blocked by [[api-gateway]] migration.
```

### Triggers (reactive automation)

```bash
composia trigger add flag-blocked \
  --field status --op eq --value blocked \
  --action tag --tag needs-attention

composia trigger add link-security \
  --field category --op eq --value auth \
  --action link --target security-audit
```

### History (temporal graph)

```bash
composia history auth-system           # Version timeline
composia changes --since 2026-04-01   # Recent activity across graph
composia snapshot before-refactor      # Save full context before big changes
```

## Use as a library

```javascript
import { createEngine } from 'composia';
import { Knowledge } from 'composia/knowledge';

const engine = await createEngine('.composia/db');
const kb = new Knowledge(engine);

// Save with auto-linking
await kb.saveNote({
  id: 'auth-decision',
  title: 'Auth Architecture Decision',
  content: 'We use [[jwt-tokens]] because [[session-cookies]] break with [[api-gateway]]. #architecture',
});

// Instant graph traversal
const { forward, backlinks } = await kb.getLinks('jwt-tokens');
const graph = await kb.getGraph('auth-decision', 2);

// Indexed property queries
const blocked = await kb.queryByProperty('status', 'blocked');

// Semantic search
const results = await kb.semanticSearch('authentication patterns');

// Temporal queries
const history = await kb.getHistory('auth-decision');
const changes = await kb.getRecentChanges({ since: '2026-04-01' });

await engine.close();
```

## Performance (vs raw file-based access)

Obsidian maintains an in-memory MetadataCache that speeds up queries while the app is running. But agents accessing a vault programmatically (via MCP, CLI, or filesystem) don't have that cache — they read files directly. These benchmarks compare Composia against that scenario, at 1,000,000 notes:

| Operation | Composia | File reads (no cache) | Advantage |
|---|---|---|---|
| Cold startup | 622ms | 16,802ms | **27x faster** |
| Local graph (depth 2) | 90ms | 15,140ms | **168x faster** |
| Backlinks | 1.3ms | 15,464ms | **11,987x faster** |
| Search | 71ms | 4,852ms | **68x faster** |

## CLI Reference

```
Setup & Sync
  composia init                    Set up Composia in a project
  composia build                   Build RocksDB from kb/ (run after git pull)
  composia sync                    Write db notes back to kb/ as .md files

Knowledge
  composia remember <text>         Quick-save (writes to db + kb/)
  composia recall <query>          Search the knowledge graph
  composia context <id>            Show note with full link context

Notes
  composia note add|get|rm|list    CRUD operations

Graph
  composia link from|to|graph      Query links and graph

Search & Query
  composia search <query>          Search by content
  composia tag <tag>               Find notes by tag
  composia query <field> <value>   Indexed property query
  composia field <field>           Show all values for a field

Rules & Triggers
  composia rules add|list|rm       Manage plain English rules
  composia trigger add|list|rm     Manage reactive triggers

Temporal
  composia history <id>            Version history of a note
  composia changes                 Recent activity across graph
  composia snapshot <label>        Save full context snapshot

Stats
  composia stats                   Database statistics
```

## License

MIT
