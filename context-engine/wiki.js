// Wiki operations: read, list, build context string

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

export class Wiki {
  constructor(dir) {
    this.dir = dir;
    this.pagesDir = join(dir, 'pages');
  }

  exists() {
    return existsSync(join(this.dir, 'index.md'));
  }

  readIndex() {
    return readFileSync(join(this.dir, 'index.md'), 'utf-8');
  }

  readSchema() {
    return readFileSync(join(this.dir, 'schema.md'), 'utf-8');
  }

  readLog() {
    return readFileSync(join(this.dir, 'log.md'), 'utf-8');
  }

  readPage(name) {
    const path = join(this.pagesDir, name.endsWith('.md') ? name : `${name}.md`);
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf-8');
  }

  writePage(name, content) {
    const fname = name.endsWith('.md') ? name : `${name}.md`;
    writeFileSync(join(this.pagesDir, fname), content);
  }

  writeIndex(content) {
    writeFileSync(join(this.dir, 'index.md'), content);
  }

  appendLog(entry) {
    const log = this.readLog();
    const now = new Date().toISOString().split('T')[0];
    writeFileSync(join(this.dir, 'log.md'), log + `\n## [${now}] ${entry}\n`);
  }

  listPages() {
    if (!existsSync(this.pagesDir)) return [];
    return readdirSync(this.pagesDir).filter(f => f.endsWith('.md'));
  }

  // Build the full wiki content as a single string for context injection
  buildContext() {
    const parts = [];

    parts.push('=== WIKI SCHEMA ===');
    parts.push(this.readSchema());

    parts.push('\n=== WIKI INDEX ===');
    parts.push(this.readIndex());

    const pages = this.listPages();
    if (pages.length > 0) {
      parts.push('\n=== WIKI PAGES ===');
      for (const page of pages) {
        const content = this.readPage(page);
        parts.push(`\n--- ${page} ---`);
        parts.push(content);
      }
    }

    return parts.join('\n');
  }

  // Build a summary context (index + page summaries, not full content)
  // Use this when the wiki is too large for full context
  buildSummaryContext() {
    const parts = [];
    parts.push('=== WIKI INDEX ===');
    parts.push(this.readIndex());
    return parts.join('\n');
  }

  pageCount() {
    return this.listPages().length;
  }
}
