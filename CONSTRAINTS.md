# Known Constraints & Limitations

## Concurrency

**Single writer process.** RocksDB (via classic-level) supports one writer process at a time. The MCP server serializes all writes through a single process, so concurrent MCP tool calls are safe. But two separate CLI commands or two MCP server instances targeting the same `.composia/db/` will fail.

**Last-write-wins on same note.** If two agents update the same note, the second write overwrites the first. No merge. This is the same constraint Obsidian has with concurrent file writes, and the same constraint Git has with uncommitted file changes.

**Mitigation:** In practice, agent sessions are sequential (one Claude Code session at a time per repo). The MCP server runs as one process. This constraint matters for future multi-agent scenarios — solving it would require a write-ahead log or CRDT layer.

## Dual-Write Ordering

The `remember` and `rules add` commands write to both `.composia/kb/` (file) and `.composia/db/` (RocksDB). The file is written first — if it fails, nothing changed in the DB. If the DB write fails after the file write, the file exists but DB is stale. Running `composia build` resolves this by rebuilding DB from files.

## Schema Discipline

Properties are unstructured. Agents can create any field name. Over time, the same concept may be stored as `status`, `state`, `Status`, `task_status`. Composia does not enforce a schema or normalize field names.

**Mitigation:** Use rules or CLAUDE.md to establish conventions. Future: add `.composia/schema.json` to define known fields and aliases.

## Knowledge Growth

No automatic pruning, decay, or garbage collection. Every `remember`, every auto-captured session, every note persists forever. A year of daily sessions could generate thousands of notes.

**Mitigation:** Manual cleanup via `composia note rm` or periodic archival. Future: add retention policies (e.g., "archive session notes older than 30 days").

## Contradictory Knowledge

Two notes can contain contradictory information. If note A says "we use JWT" and note B says "we migrated to sessions", Composia doesn't detect or resolve the conflict. The temporal history shows when each was written, but the agent must reason about which is current.

## Git Merge Conflicts

Markdown files in `.composia/kb/` are subject to normal Git merge conflicts. If two branches modify the same `.md` file, Git will flag it. Resolve the conflict, then run `composia build` to rebuild the DB.

## Benchmark Context

Performance benchmarks compare Composia (RocksDB with persistent indexes) against raw file reads without a cache. This represents the scenario where agents access a vault programmatically (MCP, CLI, filesystem) without Obsidian's desktop app running. Obsidian's in-memory MetadataCache provides faster lookups while the app is running, but that cache is not available to external processes.

## LLM Summaries

LLM-generated summaries require an API key (ANTHROPIC_API_KEY or OPENAI_API_KEY) and cost money per note. If no key is set, deterministic summaries are used (extracted from content, always correct but less semantic). LLM summaries can theoretically produce inaccurate characterizations of content, though the deterministic links/sections/hash fields remain factual.

## What This Is Not

Composia is a knowledge graph with indexes. It is not:
- A reasoning engine (it doesn't infer new knowledge)
- A vector database (no embedding-based similarity — semantic search uses TF-IDF)
- A conflict resolution system (no CRDTs, no merge logic)
- A multi-tenant database (single user/team per repo)
