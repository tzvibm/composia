import { parseLinks, parseTags, parseFrontmatter, applyTemplate, slugify } from './parser.js';

/**
 * Knowledge service — high-level operations over the engine.
 * Handles link syncing, tag extraction, frontmatter, and graph queries.
 */
export class Knowledge {
  constructor(engine) {
    this.engine = engine;
  }

  /**
   * Create or update a note. Parses content for [[links]], #tags, and
   * YAML frontmatter. Syncs everything to the graph automatically.
   */
  async saveNote({ id, title, content, tags: explicitTags, properties: explicitProps }) {
    const noteId = id || slugify(title || 'untitled');

    // Get existing note for diff/triggers
    const existing = await this.engine.getNote(noteId).catch(() => null);

    // Parse frontmatter from content
    const { properties: parsedProps, body } = parseFrontmatter(content || '');
    const properties = { ...parsedProps, ...explicitProps };

    const noteTitle = title || properties.title || noteId;

    const parsedLinks = parseLinks(body);
    const parsedTags = parseTags(body);
    const fmTags = Array.isArray(properties.tags) ? properties.tags : [];
    const allTags = [...new Set([...(explicitTags || []), ...parsedTags, ...fmTags])];

    // Save the note
    const note = await this.engine.putNote(noteId, {
      title: noteTitle,
      content,
      tags: allTags,
      properties,
    });

    // Save temporal snapshot
    await this.engine.saveSnapshot(noteId, note);

    // Sync property index
    await this.engine.syncPropertyIndex(noteId, properties, existing?.properties || {});

    // Sync tags
    await this.engine.syncTags(noteId, allTags);

    // Sync links
    const currentLinks = await this.engine.getForwardLinks(noteId);
    const currentTargets = new Set(currentLinks.map(l => l.target));
    const newTargets = new Set(parsedLinks.map(l => l.target));

    for (const target of currentTargets) {
      if (!newTargets.has(target)) {
        await this.engine.removeLink(noteId, target);
      }
    }
    for (const link of parsedLinks) {
      if (!currentTargets.has(link.target)) {
        await this.engine.putLink(noteId, link.target, link.raw);
      }
    }

    // Evaluate triggers
    const fired = await this.engine.evaluateTriggers(noteId, note, existing);
    for (const { trigger } of fired) {
      await this._executeTriggerAction(trigger, noteId, note);
    }

    return note;
  }

  async _executeTriggerAction(trigger, noteId, note) {
    switch (trigger.action) {
      case 'tag': {
        // Auto-add a tag
        const tagToAdd = trigger.actionArgs?.tag;
        if (tagToAdd && !note.tags.includes(tagToAdd)) {
          const newTags = [...note.tags, tagToAdd];
          await this.engine.putNote(noteId, { ...note, tags: newTags });
          await this.engine.syncTags(noteId, newTags);
        }
        break;
      }
      case 'link': {
        // Auto-create a link to a target note
        const target = trigger.actionArgs?.target;
        if (target) await this.engine.putLink(noteId, target);
        break;
      }
      case 'log': {
        // Write to stderr (visible in hooks output)
        const msg = trigger.actionArgs?.message || `Trigger ${trigger.id} fired on ${noteId}`;
        process.stderr?.write?.(`[Composia trigger] ${msg}\n`);
        break;
      }
    }
  }

  async getNote(id) {
    return this.engine.getNote(id);
  }

  async deleteNote(id) {
    return this.engine.deleteNote(id);
  }

  async listNotes(opts) {
    return this.engine.listNotes(opts);
  }

  /**
   * Get or set frontmatter properties on a note.
   */
  async getProperties(id) {
    const note = await this.engine.getNote(id);
    return note.properties || {};
  }

  async setProperties(id, properties) {
    const note = await this.engine.getNote(id);
    const merged = { ...(note.properties || {}), ...properties };
    return this.engine.putNote(id, { ...note, properties: merged });
  }

  async deleteProperty(id, key) {
    const note = await this.engine.getNote(id);
    const props = { ...(note.properties || {}) };
    delete props[key];
    return this.engine.putNote(id, { ...note, properties: props });
  }

  /**
   * Get all links from and to a note.
   */
  async getLinks(noteId) {
    const [forward, back] = await Promise.all([
      this.engine.getForwardLinks(noteId),
      this.engine.getBacklinks(noteId),
    ]);
    return { forward, backlinks: back };
  }

  /**
   * Get local graph around a note.
   */
  async getGraph(noteId, depth = 1) {
    return this.engine.getNeighbors(noteId, depth);
  }

  /**
   * Find notes by tag.
   */
  async findByTag(tag) {
    const noteIds = await this.engine.getNotesByTag(tag);
    const notes = [];
    for (const id of noteIds) {
      const note = await this.engine.getNote(id).catch(() => null);
      if (note) notes.push(note);
    }
    return notes;
  }

  /**
   * Search notes by title, content, or property values.
   */
  async search(query) {
    const q = query.toLowerCase();
    const results = [];
    const all = await this.engine.listNotes({ limit: 10000 });
    for (const note of all) {
      if (
        note.title?.toLowerCase().includes(q) ||
        note.content?.toLowerCase().includes(q) ||
        JSON.stringify(note.properties || {}).toLowerCase().includes(q)
      ) {
        results.push(note);
      }
    }
    return results;
  }

  /**
   * Semantic search — find notes similar to a query using simple TF-IDF-like scoring.
   * Not a full vector DB, but good enough for local knowledge graphs.
   */
  async semanticSearch(query, { limit = 10, threshold = 0.1 } = {}) {
    const queryTerms = query.toLowerCase().split(/\W+/).filter(w => w.length > 2);
    if (queryTerms.length === 0) return [];

    const all = await this.engine.listNotes({ limit: 100000 });
    const scored = [];

    for (const note of all) {
      const text = `${note.title || ''} ${note.content || ''} ${(note.tags || []).join(' ')}`.toLowerCase();
      const words = text.split(/\W+/);
      const wordSet = new Set(words);
      const wordCount = words.length || 1;

      let score = 0;
      for (const term of queryTerms) {
        if (wordSet.has(term)) {
          // Term frequency
          const tf = words.filter(w => w === term).length / wordCount;
          score += tf;
        }
        // Partial match bonus
        for (const w of wordSet) {
          if (w.includes(term) && w !== term) {
            score += 0.3 / wordCount;
          }
        }
      }

      // Boost for title matches
      if (note.title?.toLowerCase().includes(query.toLowerCase())) {
        score += 0.5;
      }

      if (score >= threshold) {
        scored.push({ ...note, _score: Math.round(score * 1000) / 1000 });
      }
    }

    scored.sort((a, b) => b._score - a._score);
    return scored.slice(0, limit);
  }

  /**
   * Create a note from a template.
   * Template is a markdown string with {{variable}} placeholders.
   */
  async createFromTemplate(template, vars = {}) {
    const content = applyTemplate(template, vars);
    const { properties } = parseFrontmatter(content);
    const id = vars.id || slugify(vars.title || properties.title || 'untitled');
    const title = vars.title || properties.title || id;
    return this.saveNote({ id, title, content });
  }

  // ── Property Index Queries ─────────────────────────────

  /**
   * Query notes by indexed property value.
   * "Give me all notes where status = blocked"
   */
  async queryByProperty(field, value) {
    const noteIds = await this.engine.queryByProperty(field, value);
    const notes = [];
    for (const id of noteIds) {
      const note = await this.engine.getNote(id).catch(() => null);
      if (note) notes.push(note);
    }
    return notes;
  }

  /**
   * Get all unique values for a field across the graph.
   * "What statuses exist?" → ["draft", "review", "done"]
   */
  async getFieldValues(field) {
    const entries = await this.engine.queryByField(field);
    const values = new Map();
    for (const { noteId, value } of entries) {
      if (!values.has(value)) values.set(value, []);
      values.get(value).push(noteId);
    }
    return Object.fromEntries(values);
  }

  // ── Temporal / History ────────────────────────────────

  /**
   * Get version history of a note.
   */
  async getHistory(noteId, opts) {
    return this.engine.getHistory(noteId, opts);
  }

  /**
   * Get a note as it was at a specific time.
   */
  async getSnapshotAt(noteId, timestamp) {
    return this.engine.getSnapshotAt(noteId, timestamp);
  }

  /**
   * Diff a note between two points in time.
   */
  async diffNote(noteId, fromTimestamp, toTimestamp) {
    return this.engine.diffNote(noteId, fromTimestamp, toTimestamp);
  }

  /**
   * Get all changes across the entire graph in a time range.
   * "What happened in the last 3 sessions?"
   */
  async getRecentChanges({ since, limit = 50 } = {}) {
    const results = [];
    for await (const [key, value] of this.engine.history.iterator({ reverse: true, limit: limit * 2 })) {
      if (since && value._snapshot_at < since) break;
      results.push(value);
      if (results.length >= limit) break;
    }
    return results;
  }

  /**
   * Save an explicit context snapshot — captures the current state of
   * multiple notes, for use before context compaction or session end.
   */
  async saveContextSnapshot(label, noteIds) {
    const snapshot = {
      label,
      timestamp: new Date().toISOString(),
      notes: [],
    };
    const ids = noteIds || (await this.engine.listNotes({ limit: 100000 })).map(n => n.id);
    for (const id of ids) {
      const note = await this.engine.getNote(id).catch(() => null);
      if (note) {
        const { forward } = await this.getLinks(id);
        snapshot.notes.push({ ...note, _links: forward.map(l => l.target) });
      }
    }
    // Store as a special note
    const snapshotId = `snapshot-${label}-${Date.now().toString(36)}`;
    await this.engine.meta.put(snapshotId, snapshot);
    return { id: snapshotId, noteCount: snapshot.notes.length, timestamp: snapshot.timestamp };
  }

  /**
   * Restore a context snapshot.
   */
  async restoreSnapshot(snapshotId) {
    const snapshot = await this.engine.meta.get(snapshotId);
    let count = 0;
    for (const note of snapshot.notes) {
      await this.saveNote({ id: note.id, title: note.title, content: note.content, tags: note.tags, properties: note.properties });
      count++;
    }
    return { restored: count, from: snapshot.label, timestamp: snapshot.timestamp };
  }

  /**
   * List all context snapshots.
   */
  async listSnapshots() {
    const results = [];
    for await (const [key, value] of this.engine.meta.iterator({ gte: 'snapshot-', lte: 'snapshot-\xff' })) {
      results.push({ id: key, label: value.label, timestamp: value.timestamp, noteCount: value.notes?.length });
    }
    return results;
  }

  // ── Triggers ──────────────────────────────────────────

  /**
   * Add a trigger rule.
   * @param {string} id - Trigger ID
   * @param {object} trigger - { field, op, value, action, actionArgs }
   *   op: 'eq' | 'neq' | 'set' | 'changed'
   *   action: 'tag' | 'link' | 'log'
   */
  async addTrigger(id, trigger) {
    return this.engine.addTrigger(id, trigger);
  }

  async removeTrigger(id) {
    return this.engine.removeTrigger(id);
  }

  async listTriggers() {
    return this.engine.listTriggers();
  }

  async stats() {
    const base = await this.engine.stats();
    const triggers = await this.engine.listTriggers();
    return { ...base, triggers: triggers.length };
  }
}
