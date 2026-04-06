/**
 * Composia Sync — bidirectional sync between .composia/kb/ markdown files and RocksDB.
 *
 * The .md files in kb/ are the source of truth for git.
 * RocksDB is a local build artifact (like node_modules).
 *
 * Build:  kb/ → RocksDB  (reconstruct indexes from markdown files)
 * Sync:   RocksDB → kb/  (write notes created via MCP/CLI back to markdown)
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from 'fs';
import path from 'path';
import { createEngine } from './engine.js';
import { Knowledge } from './knowledge.js';
import { slugify, serializeFrontmatter, parseFrontmatter } from './parser.js';

/**
 * Build RocksDB from kb/ markdown files.
 * Drops and rebuilds the entire graph — safe because kb/ is the source of truth.
 */
export async function build(kbDir, dbPath) {
  const engine = await createEngine(dbPath);
  const kb = new Knowledge(engine);

  // Clear existing data
  await engine.clear();
  // Reopen sublevels after clear
  await engine.close();
  const engine2 = await createEngine(dbPath);
  const kb2 = new Knowledge(engine2);

  const files = walkMd(kbDir);
  let noteCount = 0;
  let linkCount = 0;

  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    const rel = path.relative(kbDir, file).replace(/\.md$/, '');
    const id = slugify(rel.replace(/[\\/]/g, '-'));
    const { properties } = parseFrontmatter(content);
    const title = properties.title || rel.split(/[\\/]/).pop();

    const note = await kb2.saveNote({ id, title, content });
    noteCount++;

    const { forward } = await kb2.getLinks(id);
    linkCount += forward.length;
  }

  await engine2.close();
  return { notes: noteCount, links: linkCount };
}

/**
 * Sync RocksDB notes back to kb/ as markdown files.
 * Only writes notes that don't already exist as files or have been updated
 * since the file was last modified.
 */
export async function syncToFiles(kbDir, dbPath) {
  const engine = await createEngine(dbPath);
  const kb = new Knowledge(engine);

  mkdirSync(kbDir, { recursive: true });

  const notes = await kb.listNotes({ limit: 1000000 });
  let written = 0;
  let skipped = 0;

  for (const note of notes) {
    const filePath = path.join(kbDir, `${note.id}.md`);

    // Check if file exists and is newer than the note
    if (existsSync(filePath)) {
      const fileStat = statSync(filePath);
      const fileModified = fileStat.mtime.toISOString();
      if (fileModified >= note.updated) {
        skipped++;
        continue;
      }
    }

    // Build markdown content with frontmatter
    let content = note.content || '';

    // If the note doesn't already have frontmatter, add properties as frontmatter
    const { properties: existingProps } = parseFrontmatter(content);
    if (Object.keys(existingProps).length === 0 && note.properties && Object.keys(note.properties).length > 0) {
      const fm = serializeFrontmatter(note.properties);
      content = fm + content;
    }

    // Ensure directory exists
    const dir = path.dirname(filePath);
    mkdirSync(dir, { recursive: true });

    writeFileSync(filePath, content);
    written++;
  }

  await engine.close();
  return { written, skipped, total: notes.length };
}

/**
 * Walk a directory recursively and return all .md file paths.
 */
function walkMd(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walkMd(full));
    } else if (entry.endsWith('.md')) {
      files.push(full);
    }
  }
  return files;
}
