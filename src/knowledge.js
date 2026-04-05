import { parseLinks, parseTags, slugify } from './parser.js';

/**
 * Knowledge service — high-level operations over the engine.
 * Handles link syncing, tag extraction, and graph queries.
 */
export class Knowledge {
  constructor(engine) {
    this.engine = engine;
  }

  /**
   * Create or update a note. Parses content for [[links]] and #tags,
   * syncs them to the graph automatically.
   */
  async saveNote({ id, title, content, tags: explicitTags }) {
    const noteId = id || slugify(title || 'untitled');

    // Parse links and tags from content
    const parsedLinks = parseLinks(content || '');
    const parsedTags = parseTags(content || '');
    const allTags = [...new Set([...(explicitTags || []), ...parsedTags])];

    // Save the note
    const note = await this.engine.putNote(noteId, { title, content, tags: allTags });

    // Sync tags
    await this.engine.syncTags(noteId, allTags);

    // Sync links: get current forward links, diff, update
    const currentLinks = await this.engine.getForwardLinks(noteId);
    const currentTargets = new Set(currentLinks.map(l => l.target));
    const newTargets = new Set(parsedLinks.map(l => l.target));

    // Remove stale links
    for (const target of currentTargets) {
      if (!newTargets.has(target)) {
        await this.engine.removeLink(noteId, target);
      }
    }

    // Add new links
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
   * Search notes by title or content substring (simple scan).
   * Good enough for now — can add FTS index later.
   */
  async search(query) {
    const q = query.toLowerCase();
    const results = [];
    const all = await this.engine.listNotes({ limit: 10000 });
    for (const note of all) {
      if (
        note.title?.toLowerCase().includes(q) ||
        note.content?.toLowerCase().includes(q)
      ) {
        results.push(note);
      }
    }
    return results;
  }

  async stats() {
    return this.engine.stats();
  }
}
