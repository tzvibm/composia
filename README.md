# Composia

Embedded graph-backed knowledge base for AI agents. The SQLite of knowledge graphs.

Composia gives AI agents persistent, traversable memory that lives in your repo. Notes are linked with `[[wikilinks]]`, relationships are indexed in RocksDB, and graph traversal is instant at any scale.

## Why

- **Embedded** — `npm install composia`. No server, no Docker, no infrastructure.
- **Fast** — 1.3ms backlinks at 1M notes. 90ms local graph traversal. 7ms cold startup.
- **Agent-native** — MCP server, CLI, session hooks. Built for Claude Code, not browsers.
- **Obsidian-compatible** — Same `[[wikilink]]` syntax. Ingest existing markdown folders.

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

### Recall them

```bash
composia recall "auth"
composia context session-handler    # Shows note + all links + backlinks
composia link graph session-handler --depth 2
```

### Ingest markdown files

Put `.md` files in `.composia/kb/` with `[[wikilinks]]` between them:

```
.composia/kb/
├── architecture/
│   ├── auth-system.md       # "Uses [[jwt-tokens]] with [[api-gateway]]"
│   └── database-choice.md   # "Chose [[rocksdb]] over [[neo4j]] because [[embedded-db]]"
├── patterns/
│   └── error-handling.md
└── onboarding/
    └── getting-started.md
```

```bash
composia ingest
```

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
- **Read** the knowledge graph before making changes (finds relevant context)
- **Write** to it after sessions (captures what was done)
- **Traverse** links to understand relationships between concepts

### Team sharing

```bash
composia export > composia-snapshot.json   # Commit this to git
composia import composia-snapshot.json     # Teammates rebuild locally
```

## Use as a library

```javascript
import { createEngine } from 'composia';
import { Knowledge } from 'composia/knowledge';

const engine = await createEngine('.composia/db');
const kb = new Knowledge(engine);

await kb.saveNote({
  id: 'auth-decision',
  title: 'Auth Architecture Decision',
  content: 'We use [[jwt-tokens]] because [[session-cookies]] break with [[api-gateway]]. #architecture',
});

// Instant graph traversal
const { forward, backlinks } = await kb.getLinks('jwt-tokens');
const graph = await kb.getGraph('auth-decision', 2);
const results = await kb.search('authentication');

await engine.close();
```

## Performance (vs file-based / Obsidian-style)

At 1,000,000 notes:

| Operation | Composia | File-based | Advantage |
|---|---|---|---|
| Cold startup | 622ms | 16,802ms | **27x faster** |
| Local graph (depth 2) | 90ms | 15,140ms | **168x faster** |
| Backlinks | 1.3ms | 15,464ms | **11,987x faster** |
| Search | 71ms | 4,852ms | **68x faster** |

## CLI Reference

```
composia init                    Set up Composia in a project
composia remember <text>         Quick-save knowledge with auto-linking
composia recall <query>          Search the knowledge graph
composia context <id>            Show note with full link context
composia note add|get|rm|list    CRUD operations
composia link from|to|graph      Query links and graph
composia search <query>          Search by content
composia tag <tag>               Find notes by tag
composia stats                   Database statistics
composia export                  Export to JSON
composia import <file>           Import from JSON
composia ingest [dir]            Ingest .md folder
```

## License

MIT
