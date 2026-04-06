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
    description: 'Save a note to the knowledge graph. Content can include [[wikilinks]] to other notes — links are auto-indexed. Use this to capture decisions, bug fixes, patterns, learnings, or any knowledge worth remembering.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Note ID (slug format, e.g. "auth-refactor-decision")' },
        title: { type: 'string', description: 'Human-readable title' },
        content: { type: 'string', description: 'Markdown content with [[wikilinks]] to related notes' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for categorization' },
      },
      required: ['id', 'title', 'content'],
    },
  },
  {
    name: 'composia_get',
    description: 'Retrieve a specific note by ID, including its content, tags, and timestamps.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Note ID to retrieve' },
      },
      required: ['id'],
    },
  },
  {
    name: 'composia_search',
    description: 'Search notes by keyword in title or content. Use this to find relevant past decisions, bugs, patterns before making changes.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term' },
      },
      required: ['query'],
    },
  },
  {
    name: 'composia_links',
    description: 'Get all forward links and backlinks for a note. Shows what this note connects to and what references it.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Note ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'composia_graph',
    description: 'Traverse the local graph around a note up to a given depth. Returns connected nodes and edges — useful for understanding context and relationships.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Center note ID' },
        depth: { type: 'number', description: 'Traversal depth (default 2, max 5)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'composia_list',
    description: 'List recent notes in the knowledge graph. Returns IDs, titles, and tags.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max notes to return (default 50)' },
        tag: { type: 'string', description: 'Filter by tag' },
      },
    },
  },
  {
    name: 'composia_delete',
    description: 'Delete a note and clean up its links.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Note ID to delete' },
      },
      required: ['id'],
    },
  },
  {
    name: 'composia_properties',
    description: 'Get or set YAML frontmatter properties on a note. Use action "get" to read, "set" to update, "delete" to remove a property.',
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
    name: 'composia_semantic_search',
    description: 'Find notes semantically similar to a query. Uses TF-IDF scoring to rank by relevance, not just keyword matching.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language query' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'composia_template',
    description: 'Create a note from a template. Templates use {{variable}} placeholders. Built-in vars: {{date}}, {{time}}, {{timestamp}}, {{id}}.',
    inputSchema: {
      type: 'object',
      properties: {
        template: { type: 'string', description: 'Markdown template with {{placeholders}}' },
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
      return results.map(n => ({ id: n.id, title: n.title, tags: n.tags, excerpt: n.content?.slice(0, 200) }));
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
        return notes.slice(0, args.limit || 50).map(n => ({ id: n.id, title: n.title, tags: n.tags }));
      }
      const notes = await kb.listNotes({ limit: args.limit || 50 });
      return notes.map(n => ({ id: n.id, title: n.title, tags: n.tags }));
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

    case 'composia_semantic_search': {
      const results = await kb.semanticSearch(args.query, { limit: args.limit || 10 });
      return results.map(n => ({ id: n.id, title: n.title, tags: n.tags, score: n._score, excerpt: n.content?.slice(0, 200) }));
    }

    case 'composia_template': {
      const note = await kb.createFromTemplate(args.template, args.vars || {});
      return { created: { id: note.id, title: note.title, tags: note.tags } };
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
