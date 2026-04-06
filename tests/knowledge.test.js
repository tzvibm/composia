import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createEngine } from '../src/engine.js';
import { Knowledge } from '../src/knowledge.js';
import { rmSync } from 'fs';
import path from 'path';

const TEST_DB = path.join(process.cwd(), '.composia-test-knowledge');

describe('Knowledge', () => {
  let engine, kb;

  beforeEach(async () => {
    rmSync(TEST_DB, { recursive: true, force: true });
    engine = await createEngine(TEST_DB);
    kb = new Knowledge(engine);
  });

  afterEach(async () => {
    await engine.close();
    rmSync(TEST_DB, { recursive: true, force: true });
  });

  it('saves a note and auto-parses links', async () => {
    await kb.saveNote({ id: 'target-note', title: 'Target', content: 'I exist' });
    await kb.saveNote({
      id: 'source-note',
      title: 'Source',
      content: 'Links to [[target-note]] here',
    });

    const { forward } = await kb.getLinks('source-note');
    expect(forward).toHaveLength(1);
    expect(forward[0].target).toBe('target-note');

    const { backlinks } = await kb.getLinks('target-note');
    expect(backlinks).toHaveLength(1);
    expect(backlinks[0].source).toBe('source-note');
  });

  it('syncs links when content changes', async () => {
    await kb.saveNote({ id: 'a', title: 'A', content: 'Links to [[b]] and [[c]]' });
    expect((await kb.getLinks('a')).forward).toHaveLength(2);

    // Update: remove link to c, add link to d
    await kb.saveNote({ id: 'a', title: 'A', content: 'Links to [[b]] and [[d]]' });
    const { forward } = await kb.getLinks('a');
    expect(forward.map(l => l.target).sort()).toEqual(['b', 'd']);
  });

  it('auto-parses tags from content', async () => {
    await kb.saveNote({ id: 'n', title: 'N', content: 'Hello #rust #javascript' });
    const note = await kb.getNote('n');
    expect(note.tags).toContain('rust');
    expect(note.tags).toContain('javascript');
  });

  it('merges explicit and parsed tags', async () => {
    await kb.saveNote({
      id: 'n',
      title: 'N',
      content: 'Hello #parsed',
      tags: ['explicit'],
    });
    const note = await kb.getNote('n');
    expect(note.tags).toContain('parsed');
    expect(note.tags).toContain('explicit');
  });

  it('finds notes by tag', async () => {
    await kb.saveNote({ id: 'a', title: 'A', content: '#rust stuff' });
    await kb.saveNote({ id: 'b', title: 'B', content: '#python stuff' });
    const rustNotes = await kb.findByTag('rust');
    expect(rustNotes).toHaveLength(1);
    expect(rustNotes[0].id).toBe('a');
  });

  it('searches by content', async () => {
    await kb.saveNote({ id: 'a', title: 'Rust Guide', content: 'Learning Rust' });
    await kb.saveNote({ id: 'b', title: 'JS Guide', content: 'Learning JavaScript' });
    const results = await kb.search('rust');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('a');
  });

  it('gets local graph', async () => {
    await kb.saveNote({ id: 'a', title: 'A', content: '[[b]]' });
    await kb.saveNote({ id: 'b', title: 'B', content: '[[c]]' });
    await kb.saveNote({ id: 'c', title: 'C', content: '' });

    const graph = await kb.getGraph('a', 2);
    expect(graph.nodes).toHaveLength(3);
  });

  it('deletes note and cleans up links', async () => {
    await kb.saveNote({ id: 'a', title: 'A', content: '[[b]]' });
    await kb.saveNote({ id: 'b', title: 'B', content: '' });
    await kb.deleteNote('a');

    const { backlinks } = await kb.getLinks('b');
    expect(backlinks).toHaveLength(0);
  });

  // ── Frontmatter ──────────────────────────────────────

  it('parses frontmatter from content', async () => {
    await kb.saveNote({
      id: 'fm',
      title: 'FM',
      content: '---\ntitle: From Frontmatter\npriority: 1\ntags: [important]\n---\n# Body here',
    });
    const note = await kb.getNote('fm');
    expect(note.properties.priority).toBe(1);
    expect(note.tags).toContain('important');
  });

  it('gets and sets properties', async () => {
    await kb.saveNote({ id: 'p', title: 'P', content: 'test' });
    await kb.setProperties('p', { status: 'draft', priority: 3 });
    const props = await kb.getProperties('p');
    expect(props.status).toBe('draft');
    expect(props.priority).toBe(3);
  });

  it('deletes a property', async () => {
    await kb.saveNote({ id: 'dp', title: 'DP', content: 'test' });
    await kb.setProperties('dp', { a: 1, b: 2 });
    await kb.deleteProperty('dp', 'a');
    const props = await kb.getProperties('dp');
    expect(props.a).toBeUndefined();
    expect(props.b).toBe(2);
  });

  // ── Semantic Search ──────────────────────────────────

  it('semantic search ranks by relevance', async () => {
    await kb.saveNote({ id: 'rust-guide', title: 'Rust Programming Guide', content: 'Rust is a systems programming language focused on safety' });
    await kb.saveNote({ id: 'js-guide', title: 'JavaScript Guide', content: 'JavaScript is a dynamic programming language for the web' });
    await kb.saveNote({ id: 'cooking', title: 'Pasta Recipe', content: 'Boil water and add pasta' });

    const results = await kb.semanticSearch('rust programming');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe('rust-guide');
  });

  // ── Templates ────────────────────────────────────────

  it('creates note from template', async () => {
    const template = '---\ntitle: {{title}}\nstatus: draft\n---\n# {{title}}\n\nCreated on {{date}}';
    const note = await kb.createFromTemplate(template, { title: 'My Decision' });
    expect(note.title).toBe('My Decision');
    expect(note.content).toContain('# My Decision');
    expect(note.content).toMatch(/Created on \d{4}-\d{2}-\d{2}/);
  });

  // ── Property Index ──────────────────────────────────

  it('queries notes by indexed property', async () => {
    await kb.saveNote({ id: 'a', title: 'A', content: 'test', properties: { status: 'draft' } });
    await kb.saveNote({ id: 'b', title: 'B', content: 'test', properties: { status: 'done' } });
    await kb.saveNote({ id: 'c', title: 'C', content: 'test', properties: { status: 'draft' } });

    const drafts = await kb.queryByProperty('status', 'draft');
    expect(drafts).toHaveLength(2);
    expect(drafts.map(n => n.id).sort()).toEqual(['a', 'c']);
  });

  it('gets unique field values', async () => {
    await kb.saveNote({ id: 'x', title: 'X', content: '', properties: { priority: 'high' } });
    await kb.saveNote({ id: 'y', title: 'Y', content: '', properties: { priority: 'low' } });
    await kb.saveNote({ id: 'z', title: 'Z', content: '', properties: { priority: 'high' } });

    const values = await kb.getFieldValues('priority');
    expect(Object.keys(values).sort()).toEqual(['high', 'low']);
    expect(values.high).toHaveLength(2);
  });

  // ── Temporal History ────────────────────────────────

  it('saves and retrieves version history', async () => {
    await kb.saveNote({ id: 'evolve', title: 'V1', content: 'first' });
    await kb.saveNote({ id: 'evolve', title: 'V2', content: 'second' });
    await kb.saveNote({ id: 'evolve', title: 'V3', content: 'third' });

    const history = await kb.getHistory('evolve');
    expect(history).toHaveLength(3);
    expect(history[0].title).toBe('V3'); // most recent first
    expect(history[2].title).toBe('V1');
  });

  it('gets recent changes across graph', async () => {
    await kb.saveNote({ id: 'r1', title: 'R1', content: '' });
    await kb.saveNote({ id: 'r2', title: 'R2', content: '' });

    const changes = await kb.getRecentChanges({ limit: 10 });
    expect(changes.length).toBeGreaterThanOrEqual(2);
  });

  it('saves and lists context snapshots', async () => {
    await kb.saveNote({ id: 's1', title: 'S1', content: '' });
    await kb.saveNote({ id: 's2', title: 'S2', content: '' });

    const snap = await kb.saveContextSnapshot('before-refactor');
    expect(snap.noteCount).toBeGreaterThanOrEqual(2);

    const list = await kb.listSnapshots();
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list[0].label).toBe('before-refactor');
  });

  // ── Triggers ────────────────────────────────────────

  it('fires trigger and auto-tags on property match', async () => {
    await kb.addTrigger('flag-blocked', {
      field: 'status', op: 'eq', value: 'blocked',
      action: 'tag', actionArgs: { tag: 'needs-attention' },
    });

    await kb.saveNote({ id: 'task1', title: 'Task', content: '', properties: { status: 'blocked' } });
    const note = await kb.getNote('task1');
    expect(note.tags).toContain('needs-attention');
  });

  it('lists and removes triggers', async () => {
    await kb.addTrigger('test-trigger', {
      field: 'x', op: 'set', action: 'log', actionArgs: { message: 'test' },
    });
    const triggers = await kb.listTriggers();
    expect(triggers.length).toBeGreaterThanOrEqual(1);

    await kb.removeTrigger('test-trigger');
    const after = await kb.listTriggers();
    expect(after.find(t => t.id === 'test-trigger')).toBeUndefined();
  });
});
