# Composia

Plain language as a programmable system of computation.

## The Innovation

Composia makes natural language into a **formal computational system** — with control flow, return values, state, loops, and conditionals — structured as a graph. The LLM is the runtime that executes it.

This is not "an LLM reading prompts." It is a graph where every node is a natural language instruction, every link is control flow, every backlink carries return context, and the entire execution is **visible to the client at every step**.

Nothing like this exists.

## What It Is

- **Nodes** (MD files) = instructions, prompts, logic, conditionals
- **Links `[[target]]`** = control flow — branch, call, loop, goto
- **Backlinks + context params** = return values from child → parent
- **Properties** (YAML frontmatter) = state — parameters, flags, confidence scores
- **Triggers** = reactive hooks — when X changes, fire Y
- **History** = execution trace — debug, replay, time-travel
- **The LLM** = CPU that interprets each node sequentially

Everything is markdown files in git. Diffable, versionable, composable. The graph grows with every interaction and compounds over time.

## How Execution Works

1. A **prompt mapper** receives user input and searches the graph for relevant nodes
2. It generates a **temporary execution graph** — a plan of connected nodes to traverse
3. The LLM traverses nodes sequentially, following links as control flow
4. Each node contains instructions; the LLM executes them and produces a result
5. **Backlinks carry return context** upward — parameters, summaries, decisions
6. **Conditionals** on any link: "if code → [[code-analyzer]], if legal → [[legal-analyzer]]"
7. Nodes can trigger **side effects**: run code, call APIs, ask the user, update the graph
8. The temporary graph is modified as the LLM works — nodes added, removed, relinked
9. When the task resolves, temporary nodes are cleaned up; permanent updates persist

### Client Transparency — No Black Boxes

The client never receives a black-box response. At every step, the client sees:

- **The execution graph** — the plan, as a navigable structure of connected nodes
- **Every mutation** — nodes added, removed, or relinked as the LLM works
- **Changes to the real graph** — confidence updates, corrections, new links, new knowledge
- **All presented as LLM summaries** — not raw data dumps, but clear explanations of what changed and why

The client can **approve, reject, or modify** at any step. Every claim in the output traces back to a specific node in the graph. The reasoning is externalized, visible, and auditable.

**This eliminates hallucination.** The LLM doesn't generate from nothing — it reasons through a traceable graph. The client sees the graph, sees the changes, and controls the process. If the LLM invents something, there's no node to back it up, and the client sees that immediately.

### Confidence & Consistency

Every node and every connection carries a **confidence score** (0-1):

- When the LLM encounters evidence that **supports** existing knowledge → confidence increases, logged
- When the LLM encounters a **potential inconsistency** → confidence decreases, logged
- All confidence changes are recorded in a **confidence log** with reasoning
- When confidence drops below a threshold → **triggers reevaluation** automatically
- The graph is self-healing: inconsistencies are detected, logged, and resolved through traversal

```markdown
---
id: auth-uses-jwt
confidence: 0.92
confidence_log:
  - { delta: +0.1, reason: "Confirmed in code review of auth-service", date: "2026-04-03" }
  - { delta: -0.15, reason: "Found session-based auth in legacy endpoint", date: "2026-04-05" }
  - { delta: +0.05, reason: "Legacy endpoint confirmed deprecated", date: "2026-04-06" }
---
```

Links also carry confidence:
```markdown
## Traverse
1. [[jwt-tokens]] — core auth mechanism (confidence: 0.95)
2. [[session-cookies]] — legacy, deprecated (confidence: 0.7, needs-review)
```

## Domain-Agnostic Mapping

The mapper system is itself a graph of mapper nodes. Content is analyzed by a **root mapper** that selects domain-specific mappers to run — multiple can run in parallel on the same input.

```
Root Mapper (LLM-powered analyzer)
  ├── detects: what kind of content is this?
  ├── selects: which domain mappers apply?
  └── runs: multiple mappers in parallel

Domain Mappers (graph nodes — MD files with extraction logic)
  ├── code/
  │   ├── javascript (classes, functions, modules, imports)
  │   ├── python (classes, decorators, packages)
  │   ├── go (structs, interfaces, goroutines)
  │   └── rust (traits, impls, lifetimes)
  ├── legal/
  │   ├── contracts (clauses, parties, obligations, terms)
  │   ├── case-law (holdings, citations, precedent chains)
  │   └── regulatory (rules, exceptions, jurisdictions)
  ├── business/
  │   ├── processes (workflows, stakeholders, dependencies)
  │   ├── strategy (goals, metrics, initiatives)
  │   └── org (teams, roles, responsibilities)
  ├── research/
  │   ├── papers (claims, evidence, citations)
  │   └── brainstorm (ideas, themes, connections)
  └── generic/ (fallback: paragraphs, headings, entities)
```

Adding a new domain = adding mapper MD files to the graph. No code changes.

## Why

- **Embedded** — `npm install composia`. No server, no Docker, no infrastructure.
- **Fast** — 1.3ms backlinks at 1M notes. 90ms local graph traversal. 7ms cold startup.
- **Lightweight traversal** — Two-layer summaries: deterministic (instant) + LLM-generated (semantic). Agents scan summaries, fetch full content only when needed.
- **Agent-native** — MCP server, CLI, session hooks. Works with any LLM agent.
- **Git-native** — Markdown files in git, RocksDB built locally. Teams sync through git.
- **Obsidian-compatible** — Same `[[wikilink]]` syntax. Same markdown files.
- **Domain agnostic** — Code, law, business, research, brainstorming — same primitives.
- **Self-healing** — Confidence tracking and consistency checking built into every node and edge.

## Quick Start

```bash
npm install composia
npx composia init
```

### Map a codebase (or any content)

```bash
composia map .                         # Scans files, extracts constructs, builds navigable graph
composia map ./src --prefix src        # Map a subdirectory
```

### Remember things

```bash
composia remember "We chose RocksDB because [[embedded-db]] requirements #architecture"
composia remember "Fixed auth bug in [[session-handler]] by adding [[refresh-token-rotation]] #bugfix"
```

### Recall them (LLM-powered)

```bash
composia recall "What did we decide about auth last week?"
composia recall "Why is the payments service slow?"
composia context session-handler       # Shows note + all links + backlinks
```

### Write markdown files directly

```
.composia/
├── kb/                  ← IN GIT (source of truth)
│   ├── architecture/
│   │   ├── auth-system.md       # "Uses [[jwt-tokens]] with [[api-gateway]]"
│   │   └── database-choice.md   # "Chose [[rocksdb]] over [[neo4j]] because [[embedded-db]]"
│   ├── patterns/
│   │   └── error-handling.md
│   └── rules.md                 # Plain English rules agents follow
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

### Use with Claude Code (or any MCP-compatible agent)

Add to `.claude/settings.json`:

```json
{
  "mcpServers": {
    "composia": {
      "command": "node",
      "args": ["node_modules/composia/src/mcp.js"]
    }
  }
}
```

MCP tools available:

- **`composia_map`** — map a codebase/directory into a navigable graph
- **`composia_ask`** — natural language questions resolved via multi-step LLM reasoning
- **`composia_graph`** — traverse the neighborhood around any node with summaries
- **`composia_links`** — stored forward links + backlinks (O(log n))
- **`composia_query`** — indexed property queries ("all notes where status=blocked")
- **`composia_field_values`** — enumerate unique values across a field
- **`composia_history`** / **`composia_changes`** — temporal queries
- **`composia_save`** — write with auto-indexing of links, backlinks, properties, tags, summaries, triggers
- **`composia_get`** / **`composia_list`** / **`composia_search`** — read, scan, keyword search
- **`composia_properties`** — get/set/delete indexed properties
- **`composia_template`** / **`composia_delete`** — create from templates, delete with cleanup

### Rules (plain English directives)

```bash
composia rules add "When changing auth files, always check the security audit note"
composia rules add "Always link bug fixes to the original issue note"
```

### Property indexes (instant queries)

```bash
composia query status blocked          # All notes where status=blocked
composia query priority high           # All high-priority notes
composia field status                  # Show all unique status values
```

### Triggers (reactive automation)

```bash
composia trigger add flag-blocked \
  --field status --op eq --value blocked \
  --action tag --tag needs-attention
```

### History (temporal graph)

```bash
composia history auth-system           # Version timeline
composia changes --since 2026-04-01   # Recent activity across graph
composia snapshot before-refactor      # Save full context snapshot
```

## Architecture

```
Prompt Mapper          →  Execution Graph (temporary)  →  Resolution
  analyzes input            connected nodes to traverse     clean up temp nodes
  finds relevant nodes      LLM follows links sequentially  persist permanent updates
  generates plan            backlinks carry return context   log confidence changes

Storage:
  CLI (commander)      →  Knowledge Service  →  Engine  →  RocksDB (classic-level)
  MCP Server (mcp.js)     knowledge.js          engine.js   ├── notes sublevel
  Hooks (hooks.js)         parser.js             sync.js     ├── links sublevel
                                                             ├── backlinks sublevel
                                                             ├── tags sublevel
                                                             ├── propidx sublevel
                                                             ├── history sublevel
                                                             └── triggers sublevel
```

**Stack:** Node.js + RocksDB (classic-level) — pure JavaScript, zero native build step.

## Performance (1M notes)

| Operation | Composia | File reads (no cache) | Advantage |
|---|---|---|---|
| Cold startup | 622ms | 16,802ms | **27x faster** |
| Local graph (depth 2) | 90ms | 15,140ms | **168x faster** |
| Backlinks | 1.3ms | 15,464ms | **11,987x faster** |
| Search | 71ms | 4,852ms | **68x faster** |

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

const graph = await kb.getGraph('auth-decision', 2);
const blocked = await kb.queryByProperty('status', 'blocked');
const history = await kb.getHistory('auth-decision');

await engine.close();
```

## License

MIT
