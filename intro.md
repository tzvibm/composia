# Why Composia Exists

## The Shift to Agentic Engineering

In early 2026, Andrej Karpathy declared "vibe coding" passé and introduced what he calls **agentic engineering** — the practice of orchestrating AI agents as an engineering discipline:

> "Agentic because the new default is that you are not writing the code directly 99% of the time, you are orchestrating agents who do and acting as oversight — engineering to emphasize that there is an art and science and expertise to it."

This shift created a new problem: **agents need memory.** Not chat history, not vector embeddings — structured, traversable knowledge that persists across sessions and grows with every interaction.

## Why Everyone Reached for Obsidian

Karpathy himself uses Obsidian as the frontend for his "LLM Knowledge Bases" system, where LLMs compile raw source documents into interconnected markdown wikis. In April 2026, he shared the architecture:

> "Something I'm finding very useful recently: using LLMs to build personal knowledge bases for various topics of research interest. A large fraction of my recent token throughput is going less into manipulating code, and more into manipulating [knowledge stored as markdown]."

His system uses Obsidian Web Clipper to index articles, then has an LLM incrementally "compile" a wiki of .md files with summaries and backlinks. At ~100 articles and ~400K words, it works well.

Railly Hugo took this further, building an [Obsidian vault as a "Personal OS"](https://www.railly.dev/blog/agentic-second-brain/) — a persistence layer where AI coding agents store stack preferences, repo layouts, and past decisions across Claude Code, Cursor, and Codex sessions.

The pattern is clear: developers want their agents to remember context between sessions, and markdown + wikilinks is the natural format.

## Where Obsidian Breaks

The problem is that Obsidian was designed for humans writing personal notes, not for agents programmatically querying a knowledge graph at scale. The cracks are well-documented:

**Concurrency.** Two agents cannot safely write to the same file simultaneously. As the [obsidian-graph-mcp concurrency docs](https://github.com/drewburchfield/obsidian-graph-mcp/blob/master/docs/CONCURRENCY.md) note: "A markdown file handles concurrency by silently corrupting your data when two processes write at the same time." Solutions involve file locks and async queues — bolted on after the fact.

**Performance at scale.** Mark Nagelberg [built an agent system](https://www.marknagelberg.com/what-i-learned-building-ai-agents-on-top-of-the-obsidian-cli/) on the Obsidian CLI with 700+ person files and discovered each CLI call takes ~1 second. Finding references for a person mentioned in 561 files would take 9+ minutes. His advice: bypass the CLI entirely and use direct filesystem access for reads — defeating the purpose of the tool.

**No real queries.** Markdown files don't support filtering, sorting, or aggregation. You can't ask "show all notes where status=blocked that link to the auth module." You have to read every file and hope the agent finds what it needs.

**Not actually a database.** As one [critical analysis](https://limitededitionjonathan.substack.com/p/stop-calling-it-memory-the-problem) puts it: "Anthropic never designed .md files to be databases, but thousands of people are now building their AI systems on a foundation that was never meant to bear weight."

**Scalability ceiling.** Karpathy's approach works at ~100 articles. Users report Obsidian's graph view breaking at 100K+ notes, and mobile vaults with 40K+ notes taking over a minute to open. At 1 million notes, Obsidian is unusable.

## What Agents Actually Need

The requirements are specific:

1. **Instant graph traversal** — "What's connected to the auth module?" should take milliseconds, not seconds of file parsing.
2. **Indexed properties** — "All notes where priority=high and status=blocked" should be a key lookup, not a full scan.
3. **Backlinks without reparsing** — If note A links to note B, finding that relationship should not require reading every file in the vault.
4. **Embedded, zero-infrastructure** — Agents run in CI, in containers, in serverless functions. They can't depend on a desktop app being open.
5. **Atomic writes** — Update five related notes in one transaction, or none at all. File systems don't offer this.
6. **Temporal awareness** — "What changed in the last 3 sessions?" and "What did we know about this before the refactor?" require versioned history, not just current state.

## What Composia Does Differently

Composia is an embedded graph database for knowledge, not a note-taking app. The key architectural difference:

**Obsidian treats the graph as a derived view of text files.** Every operation starts with "read files, parse text, find links." The graph is rebuilt from scratch every time.

**Composia treats the graph as the primary data structure.** Links are indexed on write. Backlinks are stored bidirectionally. Properties are indexed in a dedicated sublevel. The text is stored inside the graph, not the other way around.

This isn't a theoretical difference. At 1 million notes:

| Operation | Composia | File-based (Obsidian-style) |
|---|---|---|
| Cold startup | 622ms | 16,802ms |
| Local graph (depth 2) | 90ms | 15,140ms |
| Backlinks | 1.3ms | 15,464ms |
| Search | 71ms | 4,852ms |

Backlinks at 1 million notes: **1.3 milliseconds vs 15 seconds.** That's a 12,000x difference.

These aren't synthetic numbers. The [benchmark suite](src/benchmark.js) creates real notes with random wikilinks and measures actual RocksDB operations vs actual filesystem reads. The file-based approach is a faithful simulation of what Obsidian does internally.

## What Composia Does NOT Do

Composia is not a replacement for Obsidian as a personal note-taking app. Obsidian has:

- A beautiful desktop UI with graph visualization, theming, and hundreds of community plugins
- A mobile app with sync
- Canvas for visual thinking
- Dataview for advanced queries within the app
- A mature community of millions of users

If you're a human writing personal notes, use Obsidian. It's excellent at that.

Composia is for the layer underneath — the programmatic knowledge graph that agents read and write at machine speed. It's the engine, not the interface.

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

Agents interact via MCP tools, CLI commands, or direct library calls:

```bash
# Claude remembers something
composia remember "Refactored auth to use [[jwt-tokens]] because [[session-cookies]] break with [[api-gateway]] #architecture"

# Claude recalls before making changes
composia recall "authentication"

# Query indexed properties instantly
composia query status blocked

# See what changed recently
composia changes --since 2026-04-01

# Rules Claude follows automatically
composia rules add "When changing auth files, always check the security audit note"
```

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

- **Developers** who want their AI coding agents to have persistent, structured memory across sessions
- **Teams** who want shared project knowledge that syncs through git — the tool they already use
- **Agent builders** who need an embedded graph database with zero infrastructure (`npm install`, 3 lines of code)
- **Anyone** hitting Obsidian's limits at scale and needing programmatic graph operations

## Links

- [Karpathy's love letter to Obsidian](https://x.com/karpathy/status/1761467904737067456) — Why markdown + local files is the right philosophy
- [Karpathy's LLM Knowledge Bases](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — The pattern Composia is built for
- [Obsidian as a Personal OS for agents](https://www.railly.dev/blog/agentic-second-brain/) — The use case, with Obsidian's limitations
- [What I learned building agents on Obsidian CLI](https://www.marknagelberg.com/what-i-learned-building-ai-agents-on-top-of-the-obsidian-cli/) — Performance reality at 700+ files
- [Stop calling it memory](https://limitededitionjonathan.substack.com/p/stop-calling-it-memory-the-problem) — Why markdown files aren't databases
