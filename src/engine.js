import { ClassicLevel } from 'classic-level';
import path from 'path';

/**
 * Composia Engine — RocksDB-backed graph store for notes and links.
 *
 * Sublevels:
 *   notes     — note_id → { id, title, content, tags[], created, updated }
 *   links     — source_id:target_id → { context }
 *   backlinks — target_id:source_id → {}
 *   tags      — tag:note_id → {}
 *   meta      — singleton keys (e.g. "vault_name")
 */
export class Engine {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
    this.notes = null;
    this.links = null;
    this.backlinks = null;
    this.tags = null;
    this.meta = null;
  }

  async open() {
    this.db = new ClassicLevel(this.dbPath, { valueEncoding: 'json' });
    this.notes = this.db.sublevel('notes', { valueEncoding: 'json' });
    this.links = this.db.sublevel('links', { valueEncoding: 'json' });
    this.backlinks = this.db.sublevel('backlinks', { valueEncoding: 'json' });
    this.tags = this.db.sublevel('tags', { valueEncoding: 'json' });
    this.meta = this.db.sublevel('meta', { valueEncoding: 'json' });
    return this;
  }

  async close() {
    if (this.db) await this.db.close();
  }

  // ── Notes ──────────────────────────────────────────────

  async putNote(id, note) {
    const now = new Date().toISOString();
    const existing = await this.getNote(id).catch(() => null);
    const record = {
      id,
      title: note.title || id,
      content: note.content || '',
      tags: note.tags || [],
      properties: note.properties || existing?.properties || {},
      created: existing?.created || now,
      updated: now,
    };
    await this.notes.put(id, record);
    return record;
  }

  async getNote(id) {
    return this.notes.get(id);
  }

  async deleteNote(id) {
    const ops = [];
    // Remove forward links
    for await (const [key] of this.links.iterator({ gte: `${id}:`, lte: `${id}:\xff` })) {
      const targetId = key.slice(id.length + 1);
      ops.push({ type: 'del', sublevel: this.links, key });
      ops.push({ type: 'del', sublevel: this.backlinks, key: `${targetId}:${id}` });
    }
    // Remove backlinks pointing to this note
    for await (const [key] of this.backlinks.iterator({ gte: `${id}:`, lte: `${id}:\xff` })) {
      const sourceId = key.slice(id.length + 1);
      ops.push({ type: 'del', sublevel: this.backlinks, key });
      ops.push({ type: 'del', sublevel: this.links, key: `${sourceId}:${id}` });
    }
    // Remove tag entries
    const note = await this.getNote(id).catch(() => null);
    if (note?.tags) {
      for (const tag of note.tags) {
        ops.push({ type: 'del', sublevel: this.tags, key: `${tag}:${id}` });
      }
    }
    ops.push({ type: 'del', sublevel: this.notes, key: id });
    await this.db.batch(ops);
  }

  async listNotes({ limit = 100, reverse = false } = {}) {
    const results = [];
    for await (const [, value] of this.notes.iterator({ limit, reverse })) {
      results.push(value);
    }
    return results;
  }

  // ── Links ──────────────────────────────────────────────

  async putLink(sourceId, targetId, context = '') {
    await this.db.batch([
      { type: 'put', sublevel: this.links, key: `${sourceId}:${targetId}`, value: { context } },
      { type: 'put', sublevel: this.backlinks, key: `${targetId}:${sourceId}`, value: {} },
    ]);
  }

  async removeLink(sourceId, targetId) {
    await this.db.batch([
      { type: 'del', sublevel: this.links, key: `${sourceId}:${targetId}` },
      { type: 'del', sublevel: this.backlinks, key: `${targetId}:${sourceId}` },
    ]);
  }

  async getForwardLinks(noteId) {
    const results = [];
    for await (const [key, value] of this.links.iterator({ gte: `${noteId}:`, lte: `${noteId}:\xff` })) {
      results.push({ target: key.slice(noteId.length + 1), ...value });
    }
    return results;
  }

  async getBacklinks(noteId) {
    const results = [];
    for await (const [key] of this.backlinks.iterator({ gte: `${noteId}:`, lte: `${noteId}:\xff` })) {
      results.push({ source: key.slice(noteId.length + 1) });
    }
    return results;
  }

  // ── Tags ───────────────────────────────────────────────

  async syncTags(noteId, newTags) {
    const note = await this.getNote(noteId).catch(() => null);
    const oldTags = note?.tags || [];
    const ops = [];
    for (const tag of oldTags) {
      if (!newTags.includes(tag)) {
        ops.push({ type: 'del', sublevel: this.tags, key: `${tag}:${noteId}` });
      }
    }
    for (const tag of newTags) {
      ops.push({ type: 'put', sublevel: this.tags, key: `${tag}:${noteId}`, value: {} });
    }
    if (ops.length) await this.db.batch(ops);
  }

  async getNotesByTag(tag) {
    const results = [];
    for await (const [key] of this.tags.iterator({ gte: `${tag}:`, lte: `${tag}:\xff` })) {
      results.push(key.slice(tag.length + 1));
    }
    return results;
  }

  // ── Graph Traversal ────────────────────────────────────

  async getNeighbors(noteId, depth = 1) {
    const visited = new Set();
    const edgeSet = new Set();
    const graph = { nodes: [], edges: [] };

    function addEdge(source, target) {
      const key = `${source}→${target}`;
      if (edgeSet.has(key)) return;
      edgeSet.add(key);
      graph.edges.push({ source, target });
    }

    const traverse = async (id, currentDepth) => {
      if (visited.has(id) || currentDepth > depth) return;
      visited.add(id);

      const note = await this.getNote(id).catch(() => null);
      if (note) {
        graph.nodes.push({ id: note.id, title: note.title });
      }

      const forward = await this.getForwardLinks(id);
      for (const link of forward) {
        await traverse(link.target, currentDepth + 1);
      }

      const back = await this.getBacklinks(id);
      for (const link of back) {
        await traverse(link.source, currentDepth + 1);
      }
    };

    await traverse(noteId, 0);

    // Now add edges only between nodes that exist in the graph
    const nodeIds = new Set(graph.nodes.map(n => n.id));
    for (const id of nodeIds) {
      const forward = await this.getForwardLinks(id);
      for (const link of forward) {
        if (nodeIds.has(link.target)) {
          addEdge(id, link.target);
        }
      }
    }

    return graph;
  }

  // ── Utility ────────────────────────────────────────────

  async clear() {
    await this.db.clear();
  }

  async stats() {
    let noteCount = 0;
    let linkCount = 0;
    for await (const _ of this.notes.keys()) noteCount++;
    for await (const _ of this.links.keys()) linkCount++;
    return { notes: noteCount, links: linkCount };
  }
}

export async function createEngine(dbPath) {
  const engine = new Engine(dbPath);
  await engine.open();
  return engine;
}
