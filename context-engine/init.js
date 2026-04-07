#!/usr/bin/env node

// Initialize the wiki structure

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const WIKI_DIR = process.env.COMPOSIA_WIKI || join(process.cwd(), '.composia', 'wiki');

function init() {
  if (existsSync(join(WIKI_DIR, 'index.md'))) {
    console.log(`Wiki already exists at ${WIKI_DIR}`);
    return;
  }

  mkdirSync(join(WIKI_DIR, 'pages'), { recursive: true });

  // Copy schema
  const schema = readFileSync(join(__dirname, 'schema.md'), 'utf-8');
  writeFileSync(join(WIKI_DIR, 'schema.md'), schema);

  // Create index
  writeFileSync(join(WIKI_DIR, 'index.md'), `# Wiki Index

This wiki serves as the living context for all interactions. Every concept, decision, and fact is stored as a page with cross-references.

## Pages

_No pages yet. The wiki will grow as the conversation progresses._
`);

  // Create log
  const now = new Date().toISOString().split('T')[0];
  writeFileSync(join(WIKI_DIR, 'log.md'), `# Wiki Log

## [${now}] init | Wiki initialized
`);

  console.log(`Wiki initialized at ${WIKI_DIR}`);
  console.log('  schema.md  — maintenance instructions');
  console.log('  index.md   — page catalog');
  console.log('  log.md     — change log');
  console.log('  pages/     — knowledge pages');
}

init();
