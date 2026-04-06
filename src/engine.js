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
    this.propIndex = this.db.sublevel('propidx', { valueEncoding: 'json' }); // field:value:noteId → {}
    this.history = this.db.sublevel('history', { valueEncoding: 'json' });   // noteId:timestamp → snapshot
    this.triggers = this.db.sublevel('triggers', { valueEncoding: 'json' }); // triggerId → { field, value, action, ... }
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

  // ── Property Indexes ───────────────────────────────────
  // Key format: field:value:noteId → {}
  // Enables instant queries like "all notes where status=blocked"

  async syncPropertyIndex(noteId, newProps, oldProps = {}) {
    const ops = [];
    // Remove old index entries
    for (const [key, val] of Object.entries(oldProps)) {
      const v = String(val);
      ops.push({ type: 'del', sublevel: this.propIndex, key: `${key}:${v}:${noteId}` });
    }
    // Add new index entries
    for (const [key, val] of Object.entries(newProps)) {
      if (val === undefined || val === null) continue;
      const v = String(val);
      ops.push({ type: 'put', sublevel: this.propIndex, key: `${key}:${v}:${noteId}`, value: {} });
    }
    if (ops.length) await this.db.batch(ops);
  }

  async queryByProperty(field, value) {
    const prefix = `${field}:${String(value)}:`;
    const results = [];
    for await (const [key] of this.propIndex.iterator({ gte: prefix, lte: prefix + '\xff' })) {
      results.push(key.slice(prefix.length));
    }
    return results;
  }

  async queryByField(field) {
    const prefix = `${field}:`;
    const results = [];
    for await (const [key] of this.propIndex.iterator({ gte: prefix, lte: prefix + '\xff' })) {
      const rest = key.slice(prefix.length);
      const lastColon = rest.lastIndexOf(':');
      const value = rest.slice(0, lastColon);
      const noteId = rest.slice(lastColon + 1);
      results.push({ noteId, value });
    }
    return results;
  }

  // ── Temporal History ──────────────────────────────────
  // Key format: noteId:timestamp → full note snapshot

  _snapshotSeq = 0;
  async saveSnapshot(noteId, note) {
    const ts = new Date().toISOString();
    const seq = String(this._snapshotSeq++).padStart(6, '0');
    await this.history.put(`${noteId}:${ts}:${seq}`, { ...note, _snapshot_at: ts });
  }

  async getHistory(noteId, { limit = 50 } = {}) {
    const results = [];
    for await (const [key, value] of this.history.iterator({
      gte: `${noteId}:`,
      lte: `${noteId}:\xff`,
      reverse: true,
      limit,
    })) {
      results.push(value);
    }
    return results;
  }

  async getSnapshotAt(noteId, timestamp) {
    // Find the most recent snapshot at or before the given timestamp
    let result = null;
    for await (const [key, value] of this.history.iterator({
      gte: `${noteId}:`,
      lte: `${noteId}:${timestamp}\xff`,
      reverse: true,
      limit: 1,
    })) {
      result = value;
    }
    return result;
  }

  async diffNote(noteId, fromTimestamp, toTimestamp) {
    const from = await this.getSnapshotAt(noteId, fromTimestamp);
    const to = toTimestamp ? await this.getSnapshotAt(noteId, toTimestamp) : await this.getNote(noteId).catch(() => null);
    if (!from && !to) return null;
    return {
      noteId,
      from: from?._snapshot_at || null,
      to: to?._snapshot_at || to?.updated || null,
      changes: {
        title: from?.title !== to?.title ? { old: from?.title, new: to?.title } : undefined,
        content: from?.content !== to?.content ? { old: from?.content, new: to?.content } : undefined,
        tags: JSON.stringify(from?.tags) !== JSON.stringify(to?.tags) ? { old: from?.tags, new: to?.tags } : undefined,
        properties: JSON.stringify(from?.properties) !== JSON.stringify(to?.properties) ? { old: from?.properties, new: to?.properties } : undefined,
      },
    };
  }

  // ── Triggers ──────────────────────────────────────────
  // Stored rules that fire when property conditions are met

  async addTrigger(id, trigger) {
    // trigger: { field, op, value, action, actionArgs }
    // op: 'eq', 'neq', 'set', 'changed'
    // action: 'tag', 'link', 'log', 'hook'
    await this.triggers.put(id, { id, ...trigger, created: new Date().toISOString() });
  }

  async removeTrigger(id) {
    await this.triggers.del(id);
  }

  async listTriggers() {
    const results = [];
    for await (const [, value] of this.triggers.iterator()) {
      results.push(value);
    }
    return results;
  }

  async evaluateTriggers(noteId, note, oldNote) {
    const triggers = await this.listTriggers();
    const fired = [];

    for (const trigger of triggers) {
      const { field, op, value: triggerValue } = trigger;
      const newVal = note.properties?.[field];
      const oldVal = oldNote?.properties?.[field];

      let match = false;
      switch (op) {
        case 'eq': match = String(newVal) === String(triggerValue); break;
        case 'neq': match = String(newVal) !== String(triggerValue); break;
        case 'set': match = newVal !== undefined && newVal !== null && oldVal === undefined; break;
        case 'changed': match = String(newVal) !== String(oldVal); break;
      }

      if (match) {
        fired.push({ trigger, noteId, oldVal, newVal });
      }
    }

    return fired;
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
