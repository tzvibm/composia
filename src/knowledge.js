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

    // Parse frontmatter from content
    const { properties: parsedProps, body } = parseFrontmatter(content || '');
    const properties = { ...parsedProps, ...explicitProps };

    // Extract title from frontmatter if not provided
    const noteTitle = title || properties.title || noteId;

    // Parse links and tags from body (not frontmatter)
    const parsedLinks = parseLinks(body);
    const parsedTags = parseTags(body);

    // Merge tags: explicit + parsed from content + frontmatter tags
    const fmTags = Array.isArray(properties.tags) ? properties.tags : [];
    const allTags = [...new Set([...(explicitTags || []), ...parsedTags, ...fmTags])];

    // Save the note with properties
    const note = await this.engine.putNote(noteId, {
      title: noteTitle,
      content,
      tags: allTags,
      properties,
    });

    // Sync tags
    await this.engine.syncTags(noteId, allTags);

    // Sync links: get current forward links, diff, update
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

    return note;
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

  async stats() {
    return this.engine.stats();
  }
}
