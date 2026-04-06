# Known Constraints & Limitations

## Concurrency

**Single writer process.** RocksDB (via classic-level) supports one writer process at a time. The MCP server serializes all writes through a single process, so concurrent MCP tool calls are safe. But two separate CLI commands or two MCP server instances targeting the same `.composia/db/` will fail.

**Last-write-wins on same note.** If two agents update the same note, the second write overwrites the first. No merge. This is the same constraint Obsidian has with concurrent file writes, and the same constraint Git has with uncommitted file changes.

**This is a deliberate design boundary, not a bug.** Composia is the SQLite of knowledge graphs — SQLite is also single-writer. The target use case is one agent session at a time per repo, which is how Claude Code, Cursor, and Codex all work today. Multi-agent systems writing simultaneously would need a server architecture (like moving from SQLite to Postgres). Solving this within the embedded model would require a write-ahead log or CRDT layer.

## Dual-Write Recovery

The `remember` and `rules add` commands write to both `.composia/kb/` (file) and `.composia/db/` (RocksDB). The file is written first — if it fails, nothing changed in the DB. If the DB write fails after the file write, the file exists but DB is stale.

**The universal recovery path is always `composia build`.** It clears the DB and reconstructs everything from the markdown files. The markdown files are the source of truth. The DB is disposable — delete `.composia/db/` and rebuild. Same recovery model as `rm -rf node_modules && npm install`.

When things look wrong:
- Wrong data in a query? → `composia build`
- Wrong data in a markdown file? → edit the file, then `composia build`
- Not sure what's wrong? → `rm -rf .composia/db && composia build`

## Schema Discipline

Without a schema, agents can create any property name. Over time, the same concept may be stored as `status`, `state`, `Status`, `task_status`. This is the #1 long-term degradation vector — it doesn't crash, doesn't throw errors, just silently degrades query correctness. `query status=blocked` misses notes stored as `state=blocked`.

**Mitigation:** `.composia/schema.json` defines known fields with types, allowed values, and aliases. Properties are auto-normalized on every save (`State` → `status`, `prio` → `priority`). Run `composia schema generate` to auto-detect fields from existing notes. Unknown fields pass through (agents need flexibility), but known fields are enforced.

## Knowledge Growth & Retrieval Degradation

Unbounded growth is not primarily a storage problem — it's a retrieval quality problem. More notes means more irrelevant candidates in search results. More links means noisier graph traversal. This is an attention problem.

**Mitigations:**
- **`composia gc`** — scores notes by relevance (recency + connectivity + tags + metadata) and archives stale, low-value notes. Archived notes are tagged `#archived`, not deleted — they're excluded from active queries but restorable.
- **Structured summaries** — agents read summaries (small, structured) not full content. The `intent` field from LLM summaries lets agents filter by type ("show me only decisions, not session logs"). This is attention optimization — reducing the surface area the agent needs to process.
- **Configurable thresholds** — `composia gc --older-than 30 --min-score 3 --dry-run` to preview before archiving.

## Contradictory Knowledge

Two notes can contain contradictory information. If note A says "we use JWT" and note B says "we migrated to sessions", Composia doesn't detect or resolve the conflict. Unlike Git conflicts (visible, explicit, blocking), knowledge conflicts are silent, semantic, and non-blocking.

The temporal history shows when each claim was made, which helps agents reason about which is current. Schema enforcement catches field-level inconsistencies (same property, different names). But deep semantic contradictions — two notes making opposing claims — remain undetected. Automatic contradiction detection would require reasoning, not just indexing. That's a future capability.

## Git Merge Conflicts

Markdown files in `.composia/kb/` are subject to normal Git merge conflicts. If two branches modify the same `.md` file, Git will flag it. Resolve the conflict, then run `composia build` to rebuild the DB.

## Benchmark Context

Performance benchmarks compare Composia (RocksDB with persistent indexes) against raw file reads without a cache. This represents the scenario where agents access a vault programmatically (MCP, CLI, filesystem) without Obsidian's desktop app running. Obsidian's in-memory MetadataCache provides faster lookups while the app is running, but that cache is not available to external processes.

## LLM Summaries

LLM-generated summaries require an API key (ANTHROPIC_API_KEY or OPENAI_API_KEY) and cost money per note. If no key is set, deterministic summaries are used (extracted from content, always correct but less semantic). LLM summaries can theoretically produce inaccurate characterizations of content, though the deterministic links/sections/hash fields remain factual.

## Agent Note Quality

Agent-generated notes are uncurated by default. Unlike human notes (which are naturally filtered by effort), agents can generate high volumes of low-value notes. Bad input scales exponentially.

**Mitigations:**
- **Rules** — plain English directives that guide agent behavior ("always include a [[wikilink]] when mentioning a system component")
- **Schema normalization** — catches field name variants automatically
- **LLM summaries with intent classification** — each note gets classified (decision/bug/pattern/architecture/reference/session/general), letting retrieval filter by intent
- **`composia gc`** — relevance scoring identifies low-signal notes for archival

**Not yet solved:** No quality gate exists — there's no pre-save evaluation of whether a note adds signal or noise. A future enhancement could use the LLM to score note quality before storing.

## What This Is Not

Composia is a knowledge graph with indexes. It is not:
- A reasoning engine (it doesn't infer new knowledge)
- A vector database (no embedding-based similarity — semantic search uses TF-IDF)
- A conflict resolution system (no CRDTs, no merge logic)
- A multi-tenant database (single user/team per repo)
