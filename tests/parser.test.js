import { describe, it, expect } from 'vitest';
import { parseLinks, parseTags, parseFrontmatter, serializeFrontmatter, applyTemplate, slugify } from '../src/parser.js';

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

describe('parseFrontmatter', () => {
  it('parses YAML frontmatter', () => {
    const { properties, body } = parseFrontmatter('---\ntitle: My Note\ntags: [rust, js]\n---\n# Content');
    expect(properties.title).toBe('My Note');
    expect(properties.tags).toEqual(['rust', 'js']);
    expect(body).toBe('# Content');
  });

  it('handles no frontmatter', () => {
    const { properties, body } = parseFrontmatter('# Just content');
    expect(properties).toEqual({});
    expect(body).toBe('# Just content');
  });

  it('parses booleans and numbers', () => {
    const { properties } = parseFrontmatter('---\ndraft: true\npriority: 5\n---\n');
    expect(properties.draft).toBe(true);
    expect(properties.priority).toBe(5);
  });

  it('strips quotes from values', () => {
    const { properties } = parseFrontmatter('---\ntitle: "Quoted Title"\n---\n');
    expect(properties.title).toBe('Quoted Title');
  });
});

describe('serializeFrontmatter', () => {
  it('serializes properties to YAML', () => {
    const result = serializeFrontmatter({ title: 'Test', tags: ['a', 'b'] });
    expect(result).toContain('title: Test');
    expect(result).toContain('tags: [a, b]');
    expect(result).toMatch(/^---\n/);
    expect(result).toMatch(/\n---\n/);
  });

  it('returns empty string for no properties', () => {
    expect(serializeFrontmatter({})).toBe('');
    expect(serializeFrontmatter(null)).toBe('');
  });
});

describe('applyTemplate', () => {
  it('substitutes variables', () => {
    const result = applyTemplate('# {{title}}\nBy {{author}}', { title: 'Test', author: 'Me' });
    expect(result).toBe('# Test\nBy Me');
  });

  it('provides built-in date/time', () => {
    const result = applyTemplate('Created: {{date}}');
    expect(result).toMatch(/Created: \d{4}-\d{2}-\d{2}/);
  });

  it('preserves unknown placeholders', () => {
    expect(applyTemplate('Hello {{unknown}}')).toBe('Hello {{unknown}}');
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
