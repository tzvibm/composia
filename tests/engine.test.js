import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createEngine } from '../src/engine.js';
import { rmSync } from 'fs';
import path from 'path';

const TEST_DB = path.join(process.cwd(), '.composia-test-engine');

describe('Engine', () => {
  let engine;

  beforeEach(async () => {
    rmSync(TEST_DB, { recursive: true, force: true });
    engine = await createEngine(TEST_DB);
  });

  afterEach(async () => {
    await engine.close();
    rmSync(TEST_DB, { recursive: true, force: true });
  });

  // ── Notes ────────────────────────────────────────────

  it('puts and gets a note', async () => {
    const note = await engine.putNote('abc', { title: 'Test', content: 'Hello', tags: [] });
    expect(note.id).toBe('abc');
    expect(note.title).toBe('Test');
    expect(note.content).toBe('Hello');

    const fetched = await engine.getNote('abc');
    expect(fetched.title).toBe('Test');
  });

  it('updates a note preserving created timestamp', async () => {
    const first = await engine.putNote('abc', { title: 'V1', content: '' });
    const second = await engine.putNote('abc', { title: 'V2', content: 'Updated' });
    expect(second.created).toBe(first.created);
    expect(second.title).toBe('V2');
  });

  it('deletes a note', async () => {
    await engine.putNote('abc', { title: 'Test', content: '' });
    await engine.deleteNote('abc');
    // classic-level sublevel returns undefined for deleted keys
    const result = await engine.getNote('abc').catch(() => undefined);
    expect(result).toBeUndefined();
  });

  it('lists notes', async () => {
    await engine.putNote('a', { title: 'A' });
    await engine.putNote('b', { title: 'B' });
    await engine.putNote('c', { title: 'C' });
    const notes = await engine.listNotes();
    expect(notes).toHaveLength(3);
  });

  it('auto-generates summary on save', async () => {
    const note = await engine.putNote('sum', {
      title: 'Auth System',
      content: '---\nstatus: active\n---\n# Auth System\n\nWe use [[jwt-tokens]] for authentication.\nThe [[api-gateway]] validates them.\n\n#architecture',
    });
    expect(note.summary).toBeTruthy();
    expect(note.summary).toContain('jwt-tokens');
    expect(note.summary).toContain('api-gateway');
    expect(note.summary).not.toContain('---'); // frontmatter stripped
    expect(note.summary.length).toBeLessThan(500);
  });

  // ── Links ────────────────────────────────────────────

  it('creates and queries forward links', async () => {
    await engine.putLink('src', 'tgt', '[[tgt]]');
    const links = await engine.getForwardLinks('src');
    expect(links).toEqual([{ target: 'tgt', context: '[[tgt]]' }]);
  });

  it('creates and queries backlinks', async () => {
    await engine.putLink('src', 'tgt');
    const backlinks = await engine.getBacklinks('tgt');
    expect(backlinks).toEqual([{ source: 'src' }]);
  });

  it('removes links in both directions', async () => {
    await engine.putLink('a', 'b');
    await engine.removeLink('a', 'b');
    expect(await engine.getForwardLinks('a')).toEqual([]);
    expect(await engine.getBacklinks('b')).toEqual([]);
  });

  it('deleting a note cleans up its links', async () => {
    await engine.putNote('a', { title: 'A' });
    await engine.putNote('b', { title: 'B' });
    await engine.putLink('a', 'b');
    await engine.deleteNote('a');
    expect(await engine.getForwardLinks('a')).toEqual([]);
    expect(await engine.getBacklinks('b')).toEqual([]);
  });

  // ── Tags ─────────────────────────────────────────────

  it('syncs and queries tags', async () => {
    await engine.putNote('note1', { title: 'N', tags: ['rust', 'js'] });
    await engine.syncTags('note1', ['rust', 'js']);

    const rustNotes = await engine.getNotesByTag('rust');
    expect(rustNotes).toContain('note1');

    // Remove 'js' tag
    await engine.syncTags('note1', ['rust']);
    const jsNotes = await engine.getNotesByTag('js');
    expect(jsNotes).not.toContain('note1');
  });

  // ── Graph ────────────────────────────────────────────

  it('traverses local graph', async () => {
    await engine.putNote('a', { title: 'A' });
    await engine.putNote('b', { title: 'B' });
    await engine.putNote('c', { title: 'C' });
    await engine.putLink('a', 'b');
    await engine.putLink('b', 'c');

    const graph = await engine.getNeighbors('a', 2);
    expect(graph.nodes.map(n => n.id).sort()).toEqual(['a', 'b', 'c']);
    // Edges include duplicates from bidirectional traversal
    const uniqueEdges = new Set(graph.edges.map(e => [e.source, e.target].sort().join('-')));
    expect(uniqueEdges.size).toBe(2); // a-b and b-c
  });

  // ── Stats ────────────────────────────────────────────

  it('reports stats', async () => {
    await engine.putNote('a', { title: 'A' });
    await engine.putNote('b', { title: 'B' });
    await engine.putLink('a', 'b');
    const s = await engine.stats();
    expect(s.notes).toBe(2);
    expect(s.links).toBe(1);
  });
});
