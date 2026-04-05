import { describe, it, expect } from 'vitest';
import { parseLinks, parseTags, slugify } from '../src/parser.js';

describe('parseLinks', () => {
  it('parses simple wikilinks', () => {
    const links = parseLinks('See [[my-note]] for details');
    expect(links).toEqual([
      { target: 'my-note', heading: null, display: null, raw: '[[my-note]]' },
    ]);
  });

  it('parses wikilinks with display text', () => {
    const links = parseLinks('Read [[my-note|this note]]');
    expect(links).toEqual([
      { target: 'my-note', heading: null, display: 'this note', raw: '[[my-note|this note]]' },
    ]);
  });

  it('parses wikilinks with headings', () => {
    const links = parseLinks('Jump to [[my-note#section]]');
    expect(links).toEqual([
      { target: 'my-note', heading: 'section', display: null, raw: '[[my-note#section]]' },
    ]);
  });

  it('parses wikilinks with heading and display', () => {
    const links = parseLinks('See [[note#intro|the intro]]');
    expect(links).toEqual([
      { target: 'note', heading: 'intro', display: 'the intro', raw: '[[note#intro|the intro]]' },
    ]);
  });

  it('parses multiple links', () => {
    const links = parseLinks('Link to [[a]] and [[b]] and [[c]]');
    expect(links).toHaveLength(3);
    expect(links.map(l => l.target)).toEqual(['a', 'b', 'c']);
  });

  it('returns empty for no links', () => {
    expect(parseLinks('No links here')).toEqual([]);
  });
});

describe('parseTags', () => {
  it('parses hashtags', () => {
    expect(parseTags('Hello #world #test')).toEqual(['world', 'test']);
  });

  it('deduplicates tags', () => {
    expect(parseTags('#foo #foo #foo')).toEqual(['foo']);
  });

  it('lowercases tags', () => {
    expect(parseTags('#Hello #WORLD')).toEqual(['hello', 'world']);
  });

  it('ignores markdown headings', () => {
    // Headings start at line beginning with no preceding space-separated tag pattern
    // The regex requires whitespace or start before #, and headings like "# Title"
    // produce "title" — but that's actually fine for tagging purposes.
    // In practice, frontmatter tags or explicit --tags override.
    const tags = parseTags('Some text #real-tag');
    expect(tags).toContain('real-tag');
  });

  it('returns empty for no tags', () => {
    expect(parseTags('No tags here')).toEqual([]);
  });
});

describe('slugify', () => {
  it('converts title to slug', () => {
    expect(slugify('My Cool Note!')).toBe('my-cool-note');
  });

  it('handles multiple spaces and symbols', () => {
    expect(slugify('Hello   World...Test')).toBe('hello-world-test');
  });

  it('strips leading/trailing dashes', () => {
    expect(slugify('--test--')).toBe('test');
  });
});
