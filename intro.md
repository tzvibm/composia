# Why Composia Exists

## The Problem: Agents Need Memory

AI coding agents lose everything between sessions. There's no persistent, structured memory — no way for an agent to know what decisions were made last week, what patterns the team follows, or what bugs have been fixed before.

This isn't a new observation. Multiple people have been working on it:

**Andrej Karpathy** described the most complete vision with his "LLM Knowledge Bases" system — LLMs that compile raw source documents (articles, papers, docs) into interconnected markdown wikis with summaries and backlinks. His system uses Obsidian Web Clipper to index articles, then has an LLM incrementally "compile" a wiki of .md files. At ~100 articles and ~400K words, it works well. He noted:

> "I think there is room here for an incredible new product instead of a hacky collection of scripts."

**Railly Hugo** built an [Obsidian vault as a "Personal OS"](https://www.railly.dev/blog/agentic-second-brain/) — a persistence layer where AI coding agents store stack preferences, repo layouts, and past decisions across sessions.

**Developers broadly** have been using Obsidian as a **patterns library** — storing coding patterns, architectural conventions, and project rules as interconnected markdown notes that agents can reference.

The concept is well-established. The question is implementation.

## What Everyone Uses Today (and Where It Breaks)

Obsidian became the default tool because it already existed and supported `[[wikilinks]]` and markdown. But it was designed for humans writing personal notes, not for agents programmatically querying a knowledge graph.

## Where Obsidian Breaks

The problem is that Obsidian was designed for humans writing personal notes, not for agents programmatically querying a knowledge graph at scale. The cracks are well-documented:

**Concurrency.** Two agents cannot safely write to the same file simultaneously. As the [obsidian-graph-mcp concurrency docs](https://github.com/drewburchfield/obsidian-graph-mcp/blob/master/docs/CONCURRENCY.md) note: "A markdown file handles concurrency by silently corrupting your data when two processes write at the same time." Solutions involve file locks and async queues — bolted on after the fact.

**Performance at scale.** Mark Nagelberg [built an agent system](https://www.marknagelberg.com/what-i-learned-building-ai-agents-on-top-of-the-obsidian-cli/) on the Obsidian CLI with 700+ person files and discovered each CLI call takes ~1 second. Finding references for a person mentioned in 561 files would take 9+ minutes. His advice: bypass the CLI entirely and use direct filesystem access for reads — defeating the purpose of the tool.

**No structured queries outside the app.** While Obsidian's Dataview plugin can run queries within the desktop app, there's no programmatic API for agents to query "all notes where status=blocked that link to the auth module." MCP servers that access vaults via the filesystem must read and parse files to answer such queries.

**Not actually a database.** As one [critical analysis](https://limitededitionjonathan.substack.com/p/stop-calling-it-memory-the-problem) puts it: "Anthropic never designed .md files to be databases, but thousands of people are now building their AI systems on a foundation that was never meant to bear weight."

**Scalability ceiling.** Karpathy's approach works at ~100 articles. Users report Obsidian's graph view breaking at 100K+ notes, and mobile vaults with 40K+ notes taking over a minute to open. At 1 million notes, Obsidian is unusable.

## What Agents Actually Need

The requirements are specific:

1. **Instant graph traversal without a running app** — Obsidian's MetadataCache provides this, but only while the desktop app is running. Agents need it from a library call.
2. **Indexed properties** — "All notes where priority=high and status=blocked" should be a key lookup. Obsidian's cache doesn't support arbitrary property queries across the vault.
3. **Persistent indexes** — Obsidian rebuilds its cache on startup from files. Composia's indexes are persisted in RocksDB and survive restarts with zero rebuild time.
4. **Embedded, zero-infrastructure** — Agents run in CI, in containers, in serverless functions. They can't depend on a desktop app being open.
5. **Atomic writes** — Update five related notes in one transaction, or none at all. File systems don't offer this.
6. **Temporal awareness** — "What changed in the last 3 sessions?" and "What did we know about this before the refactor?" require versioned history, not just current state.

## What Composia Actually Contributes

Composia is not a new idea. The concept of LLM knowledge bases, markdown wikis with wikilinks, and agent memory — these all exist. Karpathy described the vision, Obsidian provides the format, Neo4j provides graph databases.

**Composia's contribution is narrow and specific: an embedded, agent-native graph engine for the knowledge base workflow.** It's plumbing, not a paradigm.

Here's what that means concretely:

**To be fair to Obsidian:** it does maintain a MetadataCache that incrementally indexes links, tags, and frontmatter as files change. It doesn't naively reparse the entire vault on every operation. Backlinks and the graph view are served from this in-memory cache, not from raw file reads each time.

But the cache is still **derived from files and lives in memory.** On cold startup, every file must be read and parsed to rebuild it. The cache isn't queryable beyond what Obsidian's UI exposes — there's no API for "give me all notes where status=blocked that link to auth-module." And critically, the cache only exists while Obsidian is running as a desktop app. Agents running in CI, containers, or serverless functions can't use it.

**Composia's graph is the primary data structure, persisted on disk.** Links, backlinks, properties, and tags are indexed in dedicated RocksDB sublevels. The graph survives process restarts with zero rebuild time. And every index is directly queryable via API.

**To be fair to Neo4j:** it's a far more capable graph database. But it requires a running server — you can't embed it in a repo like SQLite. Composia trades Neo4j's query power for zero-infrastructure embeddability.

**Lightweight traversal via auto-summaries.** Every note in Composia has a structured `summary` field with two layers:

**Layer 1 — Deterministic (instant, on every save):**
- **body**: First meaningful sentences, stripped of markdown formatting (280 chars)
- **links**: All `[[wikilink]]` targets referenced (up to 20)
- **sections**: All `##` headings — structural outline
- **hash**: SHA-256 of content (16 chars) for staleness detection

This layer is computed synchronously as part of the write operation. It cannot drift from content because there's no separate update path. It's always available, even without an API key.

**Layer 2 — LLM-generated (async, semantic):**
- **body**: Semantic summary that captures meaning, not just first sentences ("Decision to use JWT over sessions due to API gateway constraints" vs "We use jwt-tokens for authentication")
- **intent**: Classification — decision, bug, pattern, architecture, reference, session, general
- **keywords**: Key terms not already in the title or links

Since Composia is always used with an LLM agent, the LLM is always available. The deterministic summary serves as an immediate placeholder; the LLM summary replaces it async when ready. The deterministic links/sections/hash are always preserved regardless.

When an agent traverses the graph via `composia_graph` or `composia_list`, it gets summaries for every node. It can scan hundreds of notes in a single call — understanding what each note is about (body), what it connects to (links), how it's structured (sections), and what kind of knowledge it represents (intent) — then `composia_get` only the specific notes it needs to read in full.

In Obsidian, all the content lives inside the file — there's no way to skim the graph without parsing every note's full markdown. It's the difference between scanning a table of contents and reading every chapter.

The practical difference shows in our benchmarks — which compare Composia's RocksDB against **raw file-based reads** (the worst case for Obsidian, equivalent to cold startup or programmatic access without the desktop app running):

| Operation | Composia | File-based (no cache) |
|---|---|---|
| Cold startup | 622ms | 16,802ms |
| Local graph (depth 2) | 90ms | 15,140ms |
| Backlinks | 1.3ms | 15,464ms |
| Search | 71ms | 4,852ms |

These numbers represent the scenario agents actually face: programmatic access to vault data without Obsidian's desktop app and its in-memory cache. When agents access an Obsidian vault via MCP or filesystem, they're doing file reads — not querying the MetadataCache.

## What Composia Does NOT Do

Composia is not a replacement for Obsidian as a personal note-taking app. Obsidian has a beautiful desktop UI, mobile app, Canvas, Dataview, and a mature community of millions. If you're a human writing personal notes, use Obsidian.

Composia also does **not** do what Karpathy described. His system has an LLM *compiling* raw sources into structured wiki entries — that's an ingestion/compilation pipeline. Composia is a storage and query layer. It could sit underneath a Karpathy-style compilation workflow, but it doesn't provide the compilation step itself. That's a gap, not a feature.

**What Composia is:** an embedded graph engine that indexes `[[wikilinks]]`, properties, and tags in RocksDB sublevels, exposing them via MCP tools and CLI for agents to query at machine speed. It handles the plumbing — storage, indexing, traversal, sync — not the intelligence.

## The Architecture

```
npm install composia
```

```
.composia/
├── db/          ← RocksDB graph (gitignored, rebuilt from kb/)
└── kb/          ← Markdown knowledge base (committed to git)
    ├── architecture/
    │   └── auth-system.md    # "Uses [[jwt-tokens]] with [[api-gateway]]"
    ├── decisions/
    │   └── chose-rocksdb.md  # "Chose [[rocksdb]] over [[neo4j]] because [[embedded-db]]"
    └── rules.md              # Plain English rules Claude follows
```

The same `[[wikilink]]` syntax Obsidian uses. The same markdown files developers already write. But underneath, every link is indexed, every property is queryable, and every change is versioned.

## Patterns: The Core Use Case

The most common way developers use Obsidian with agents today is as a patterns library. This isn't Composia's invention — developers were already doing this. Composia adds indexed graph traversal on top of it:

```
.composia/kb/patterns/
├── error-handling.md      # "Use [[result-pattern]] not exceptions. Flows through [[error-middleware]]."
├── result-pattern.md      # "---\napplies_to: [services, repositories]\n---\nReturn {ok, data} or {ok: false, error}"
├── api-conventions.md     # "REST via [[naming-conventions]]. Auth via [[jwt-pattern]]."
├── testing-patterns.md    # "[[arrange-act-assert]] for unit. [[test-containers]] for integration."
└── di-pattern.md          # "Constructor injection. See [[service-registry]]."
```

In Obsidian, these are just files. Searching for "how do we handle errors" means reading each file. Finding all patterns that apply to services means grepping.

In Composia:
- `composia_graph("error-handling", 2)` — traverses the error pattern, the result pattern it depends on, the middleware it flows through, and the logging conventions it connects to. All via stored, indexed edges. Summaries on every node.
- `composia query applies_to services` — instant indexed lookup across all patterns. No scanning.
- Pre-hook: when Claude is about to write a new service, the hook traverses related pattern nodes and surfaces them automatically.

The difference isn't conceptual — it's mechanical. Obsidian stores patterns as documents that agents access via file reads. Composia stores them as graph nodes with indexed edges and queryable properties, accessible via API calls. Same patterns, faster lookups.

Agents interact via MCP tools, CLI commands, or direct library calls:

```bash
# Claude remembers something
composia remember "Refactored auth to use [[jwt-tokens]] because [[session-cookies]] break with [[api-gateway]] #architecture"

# Claude asks the graph a question — LLM reasons over the graph to find the answer
composia recall "What did we decide about auth and why?"
# → Synthesized answer referencing [[auth-decision]], [[jwt-migration]], [[api-gateway-config]]

# Query indexed properties instantly
composia query status blocked

# See what changed recently
composia changes --since 2026-04-01

# Rules Claude follows automatically
composia rules add "When changing auth files, always check the security audit note"
```

The `recall` command and `composia_ask` MCP tool use LLM reasoning, not keyword matching. The LLM sees note summaries, generates multi-step query strategies (keyword search + property queries + graph traversal + temporal queries), executes them against the graph, then synthesizes a natural language answer. This is how an agent should interact with knowledge — through reasoning, not regex.

## Team Workflow

There's no special sync protocol. Markdown files in `.composia/kb/` are the source of truth — they go in git like any other code. RocksDB is a local build artifact, like `node_modules`.

```bash
# Developer A captures knowledge during a session
composia remember "Auth now uses [[jwt-tokens]] with [[refresh-token-rotation]] #architecture"
# → writes to .composia/kb/auth-now-uses-jwt-tokens.md AND indexes in local RocksDB
git add .composia/kb/ && git commit && git push

# Developer B (or a new machine, or CI)
git pull
composia build    # Rebuilds RocksDB from kb/ files — indexes, links, backlinks, properties
# → graph is ready, all queries instant
```

When Claude creates notes via MCP or hooks during a session, `composia sync` writes them back to `kb/` as markdown files for the next git commit.

No JSON exports. No database dumps. No special migration tools. Just markdown in git and a local build step.

## Who This Is For

- **Developers** who want programmatic graph queries on their knowledge base without running a server
- **Teams** who want shared knowledge that syncs through git without special tooling
- **Agent builders** who need an embedded graph database (`npm install`, 3 lines of code)

If Obsidian's file-based access is fast enough for your use case, you probably don't need Composia. If you're hitting performance walls with programmatic access at scale, or you need indexed property queries from CI/agents, that's where this helps.

## Prior Art and Influences

Composia didn't invent any of these ideas. These are the people and projects that did:

- [Karpathy's LLM Knowledge Bases](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — The vision: LLMs compiling knowledge into interconnected markdown wikis. Composia is a possible storage layer for this workflow, not the workflow itself.
- [Karpathy's love letter to Obsidian](https://x.com/karpathy/status/1761467904737067456) — Why markdown + local files is the right philosophy. We agree and use the same format.
- [Obsidian as a Personal OS for agents](https://www.railly.dev/blog/agentic-second-brain/) — Railly Hugo's architecture for agent persistence. Composia attempts to solve the same problem with an embedded DB instead of file reads.
- [What I learned building agents on Obsidian CLI](https://www.marknagelberg.com/what-i-learned-building-ai-agents-on-top-of-the-obsidian-cli/) — Performance reality at 700+ files. Motivated the RocksDB approach.
- [Stop calling it memory](https://limitededitionjonathan.substack.com/p/stop-calling-it-memory-the-problem) — Why markdown files aren't databases. We agree — that's why there's a database underneath.
