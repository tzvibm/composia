#!/usr/bin/env node

/**
 * Composia MCP Server
 *
 * Exposes the knowledge graph to Claude Code via the Model Context Protocol.
 * Claude can read, write, search, and traverse the graph using tool calls.
 *
 * Usage in .claude/settings.json:
 *   "mcpServers": {
 *     "composia": { "command": "node", "args": ["node_modules/composia/src/mcp.js"] }
 *   }
 */

import { createEngine } from './engine.js';
import { Knowledge } from './knowledge.js';
import { parseLinks, parseTags } from './parser.js';
import path from 'path';

const DB_PATH = process.env.COMPOSIA_DB || path.join(process.cwd(), '.composia', 'db');

// ── MCP Protocol over stdin/stdout ──────────────────────

let kb = null;
let engine = null;
let requestId = 0;

function send(msg) {
  const json = JSON.stringify(msg);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

// ── Tool Definitions ────────────────────────────────────

const TOOLS = [
  {
    name: 'composia_save',
    description: `Save a note to the knowledge graph. This is the primary write operation.

On save, the engine automatically:
- Indexes all [[wikilinks]] as first-class graph edges (forward links + backlinks)
- Parses and indexes #tags
- Parses YAML frontmatter into queryable indexed properties
- Normalizes property names via schema aliases (e.g. "State" → "status")
- Creates a temporal snapshot (version history)
- Generates a structured summary (body + links + sections + content hash)
- Fires any matching triggers (auto-tag, auto-link based on property conditions)
- Queues LLM summary generation (async, if API key available)

Use [[wikilinks]] liberally — they create traversable graph edges. Link to file nodes (e.g. [[file-auth]]), decision nodes (e.g. [[chose-jwt]]), concept nodes (e.g. [[api-gateway]]). The more links, the richer the graph.

Use YAML frontmatter for queryable properties:
---
status: active
priority: high
intent: decision
---`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Note ID (slug format, e.g. "auth-refactor-decision"). File nodes use "file-" prefix (e.g. "file-auth")' },
        title: { type: 'string', description: 'Human-readable title' },
        content: { type: 'string', description: 'Markdown content with [[wikilinks]] to create graph edges, #tags, and optional YAML frontmatter for indexed properties' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization and filtering' },
      },
      required: ['id', 'title', 'content'],
    },
  },
  {
    name: 'composia_get',
    description: 'Retrieve full note content by ID. Returns content, tags, properties, summary, timestamps. Use this after scanning summaries via composia_graph or composia_list to deep-dive into a specific note.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Note ID to retrieve' },
      },
      required: ['id'],
    },
  },
  {
    name: 'composia_links',
    description: `Get all forward links and backlinks for a note. This is a graph primitive — it returns the direct edges, not search results.

Forward links: notes this note references via [[wikilinks]]
Backlinks: notes that reference this note via [[wikilinks]]

Use this to understand relationships: "What does auth-service depend on?" (forward links) and "What depends on auth-service?" (backlinks). Backlinks are stored, not inferred — this is O(log n), not a full scan.

Combine with composia_get on the linked IDs to build full context.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Note ID — can be a concept (auth-system), file (file-auth), session (session-2026-04-05), or any node' },
      },
      required: ['id'],
    },
  },
  {
    name: 'composia_graph',
    description: `Traverse the local graph around a note to a given depth. Returns ALL connected nodes with their summaries and ALL edges between them.

Each node includes: { id, title, summary: { body, links[], sections[], hash, intent?, keywords? }, tags }

This is the primary exploration tool. Use it to:
- Understand the neighborhood of a concept before making changes
- Find related decisions, bugs, and patterns connected to a file
- Map dependencies: composia_graph("file-auth", 3) shows everything within 3 hops
- Discover unexpected connections between concepts

The summary on each node gives you enough context to understand what the note is about without reading full content. Only use composia_get for notes you need to read in full.

File nodes (file-*) accumulate session links automatically — traversing a file node shows all sessions that touched it and all decisions related to it.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Center note ID to traverse from' },
        depth: { type: 'number', description: 'Traversal depth (default 2, max 5). Depth 1 = direct connections. Depth 2 = connections of connections. Depth 3+ for broad exploration.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'composia_query',
    description: `Query notes by indexed property value. Returns all notes where a specific property field equals a specific value. This is an O(log n) index lookup, not a scan.

Properties come from YAML frontmatter and are auto-indexed on every save. Schema aliases are applied (e.g. "State" normalizes to "status").

Examples:
- composia_query("status", "blocked") → all blocked notes
- composia_query("intent", "decision") → all decision notes
- composia_query("assignee", "alice") → all notes assigned to alice
- composia_query("priority", "critical") → all critical-priority notes

Combine with composia_links to find e.g. "blocked notes that link to auth":
1. composia_query("status", "blocked") → get IDs
2. composia_links(each ID) → check if any link to auth`,
    inputSchema: {
      type: 'object',
      properties: {
        field: { type: 'string', description: 'Property field name (e.g. "status", "priority", "intent", "assignee")' },
        value: { type: 'string', description: 'Value to match (e.g. "blocked", "high", "decision")' },
      },
      required: ['field', 'value'],
    },
  },
  {
    name: 'composia_field_values',
    description: `Show all unique values for a property field across the entire graph, with the note IDs that have each value.

Use this to understand what states exist: composia_field_values("status") → { draft: [id1, id2], active: [id3], blocked: [id4, id5] }

This is how you discover the shape of the data without knowing the schema in advance.`,
    inputSchema: {
      type: 'object',
      properties: {
        field: { type: 'string', description: 'Property field to enumerate' },
      },
      required: ['field'],
    },
  },
  {
    name: 'composia_history',
    description: `Get the version history of a specific note. Every save creates a timestamped snapshot. Returns versions in reverse chronological order.

Use this to answer: "What did this note say before the last change?" or "When was this decision made?" or "How has this evolved over time?"

Each version includes the full note state at that point in time.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Note ID to get history for' },
        limit: { type: 'number', description: 'Max versions to return (default 10)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'composia_changes',
    description: `Get recent changes across the entire knowledge graph. Returns all note saves in reverse chronological order, across all notes.

Use this to answer: "What happened in the last session?" or "What changed this week?" or "Show me all recent activity."

Filter with 'since' to narrow the time range.`,
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'ISO timestamp — only return changes after this time (e.g. "2026-04-01")' },
        limit: { type: 'number', description: 'Max changes to return (default 20)' },
      },
    },
  },
  {
    name: 'composia_list',
    description: 'List notes with summaries. Use tag filter to narrow by category. Each note includes its structured summary — scan many notes without reading full content.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max notes to return (default 50)' },
        tag: { type: 'string', description: 'Filter by tag (e.g. "architecture", "session", "file", "rules", "auto-captured")' },
      },
    },
  },
  {
    name: 'composia_search',
    description: 'Keyword search across note titles, content, and properties. Returns summaries. Use composia_ask for complex queries that need reasoning. Use composia_query for exact property matches.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term' },
      },
      required: ['query'],
    },
  },
  {
    name: 'composia_ask',
    description: `Ask a natural language question about the knowledge graph. Uses LLM reasoning to:
1. Analyze the question and the graph structure
2. Generate multiple query strategies (keyword search, property queries, graph traversal, temporal queries)
3. Execute all strategies against the graph
4. Synthesize a natural language answer referencing specific notes

Use this for complex questions like:
- "What did we decide about auth and why?"
- "What's blocking the API gateway migration?"
- "Show me everything that changed since Monday that relates to payments"
- "What patterns do we use for error handling?"

Returns: { answer, notes[], strategies[], reasoning }`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language question about the knowledge graph' },
      },
      required: ['query'],
    },
  },
  {
    name: 'composia_properties',
    description: `Get, set, or delete indexed properties on a note. Properties are stored as YAML frontmatter AND indexed in a dedicated sublevel for instant queries via composia_query.

Setting a property auto-normalizes via schema aliases and fires matching triggers.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Note ID' },
        action: { type: 'string', enum: ['get', 'set', 'delete'], description: 'Action to perform' },
        key: { type: 'string', description: 'Property key (for set/delete)' },
        value: { description: 'Property value (for set)' },
      },
      required: ['id', 'action'],
    },
  },
  {
    name: 'composia_delete',
    description: 'Delete a note and atomically clean up all its forward links, backlinks, tag index entries, and property index entries.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Note ID to delete' },
      },
      required: ['id'],
    },
  },
  {
    name: 'composia_template',
    description: 'Create a note from a template with {{variable}} substitution. Built-in vars: {{date}}, {{time}}, {{timestamp}}, {{id}}. The created note gets full indexing (links, tags, properties, summary).',
    inputSchema: {
      type: 'object',
      properties: {
        template: { type: 'string', description: 'Markdown template with {{placeholders}} and optional YAML frontmatter' },
        vars: { type: 'object', description: 'Variables to substitute (e.g. { "title": "My Note" })' },
      },
      required: ['template'],
    },
  },
];

// ── Tool Handlers ───────────────────────────────────────

async function handleTool(name, args) {
  switch (name) {
    case 'composia_save': {
      const note = await kb.saveNote({
        id: args.id,
        title: args.title,
        content: args.content,
        tags: args.tags || [],
      });
      return { saved: { id: note.id, title: note.title, tags: note.tags, updated: note.updated } };
    }

    case 'composia_get': {
      const note = await kb.getNote(args.id);
      return note;
    }

    case 'composia_search': {
      const results = await kb.search(args.query);
      return results.map(n => ({ id: n.id, title: n.title, tags: n.tags, summary: n.summary }));
    }

    case 'composia_links': {
      return await kb.getLinks(args.id);
    }

    case 'composia_graph': {
      const depth = Math.min(args.depth || 2, 5);
      return await kb.getGraph(args.id, depth);
    }

    case 'composia_list': {
      if (args.tag) {
        const notes = await kb.findByTag(args.tag);
        return notes.slice(0, args.limit || 50).map(n => ({ id: n.id, title: n.title, tags: n.tags, summary: n.summary }));
      }
      const notes = await kb.listNotes({ limit: args.limit || 50 });
      return notes.map(n => ({ id: n.id, title: n.title, tags: n.tags, summary: n.summary }));
    }

    case 'composia_delete': {
      await kb.deleteNote(args.id);
      return { deleted: args.id };
    }

    case 'composia_properties': {
      if (args.action === 'get') {
        return await kb.getProperties(args.id);
      } else if (args.action === 'set') {
        await kb.setProperties(args.id, { [args.key]: args.value });
        return { updated: args.id, key: args.key, value: args.value };
      } else if (args.action === 'delete') {
        await kb.deleteProperty(args.id, args.key);
        return { deleted_property: args.key, from: args.id };
      }
      throw new Error('action must be get, set, or delete');
    }

    case 'composia_template': {
      const note = await kb.createFromTemplate(args.template, args.vars || {});
      return { created: { id: note.id, title: note.title, tags: note.tags } };
    }

    case 'composia_query': {
      const notes = await kb.queryByProperty(args.field, args.value);
      return notes.map(n => ({ id: n.id, title: n.title, tags: n.tags, summary: n.summary, properties: n.properties }));
    }

    case 'composia_field_values': {
      return await kb.getFieldValues(args.field);
    }

    case 'composia_history': {
      return await kb.getHistory(args.id, { limit: args.limit || 10 });
    }

    case 'composia_changes': {
      return await kb.getRecentChanges({ since: args.since, limit: args.limit || 20 });
    }

    case 'composia_ask': {
      const { createResolver } = await import('./resolve.js');
      const resolver = createResolver(kb);
      if (!resolver) {
        // Fallback to keyword search if no API key
        const results = await kb.search(args.query);
        return { answer: null, notes: results.slice(0, 10).map(n => ({ id: n.id, title: n.title, summary: n.summary })), fallback: true };
      }
      return await resolver.resolve(args.query);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── MCP Message Handler ─────────────────────────────────

async function handleMessage(msg) {
  const { method, id, params } = msg;

  switch (method) {
    case 'initialize':
      return sendResult(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'composia', version: '2.0.0' },
      });

    case 'notifications/initialized':
      // Client confirmed init — open the DB
      engine = await createEngine(DB_PATH);
      kb = new Knowledge(engine);
      return;

    case 'tools/list':
      return sendResult(id, { tools: TOOLS });

    case 'tools/call': {
      const { name, arguments: args } = params;
      try {
        const result = await handleTool(name, args || {});
        return sendResult(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        });
      } catch (err) {
        return sendResult(id, {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true,
        });
      }
    }

    default:
      if (id) sendError(id, -32601, `Method not found: ${method}`);
  }
}

// ── stdin reader (Content-Length framing) ────────────────

let buffer = '';

process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;

  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;

    const header = buffer.slice(0, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) { buffer = buffer.slice(headerEnd + 4); continue; }

    const len = parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + len) break; // Wait for more data

    const body = buffer.slice(bodyStart, bodyStart + len);
    buffer = buffer.slice(bodyStart + len);

    try {
      const msg = JSON.parse(body);
      handleMessage(msg).catch(err => {
        process.stderr.write(`MCP error: ${err.message}\n`);
      });
    } catch (err) {
      process.stderr.write(`JSON parse error: ${err.message}\n`);
    }
  }
});

process.stdin.on('end', async () => {
  if (engine) await engine.close();
  process.exit(0);
});
