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
});
