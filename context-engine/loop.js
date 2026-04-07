#!/usr/bin/env node

// Interactive loop: wiki-as-context conversation

import { createInterface } from 'readline';
import { join } from 'path';
import { Wiki } from './wiki.js';
import { ContextEngine } from './context.js';

const WIKI_DIR = process.env.COMPOSIA_WIKI || join(process.cwd(), '.composia', 'wiki');

const wiki = new Wiki(WIKI_DIR);
if (!wiki.exists()) {
  console.error('Wiki not initialized. Run: node context-engine/init.js');
  process.exit(1);
}

const engine = new ContextEngine(wiki, {
  model: process.env.COMPOSIA_MODEL || 'claude-sonnet-4-20250514',
  builderModel: process.env.COMPOSIA_BUILDER_MODEL || 'claude-haiku-4-5-20251001'
});

const rl = createInterface({
  input: process.stdin,
  output: process.stdout
});

let turnCount = 0;

console.log('Composia Context Engine');
console.log('Wiki-as-context — no chat history');
console.log(`Wiki: ${WIKI_DIR} (${wiki.pageCount()} pages)`);
console.log('Type "quit" to exit, "wiki" to see wiki stats, "pages" to list pages\n');

function prompt() {
  rl.question('You: ', async (input) => {
    input = input.trim();
    if (!input) return prompt();

    if (input === 'quit') {
      console.log(`\nSession ended. Wiki has ${wiki.pageCount()} pages.`);
      rl.close();
      return;
    }

    if (input === 'wiki') {
      console.log(`\nWiki: ${wiki.pageCount()} pages`);
      console.log(wiki.readIndex());
      return prompt();
    }

    if (input === 'pages') {
      const pages = wiki.listPages();
      console.log(`\n${pages.length} pages: ${pages.join(', ')}`);
      return prompt();
    }

    try {
      turnCount++;
      console.log(`\n[Turn ${turnCount}: updating wiki with your input...]`);

      const result = await engine.turn(input);

      console.log(`[Wiki: ${result.wikiStats.totalPages} pages | +${result.wikiStats.pagesAfterUserUpdate} from input, +${result.wikiStats.pagesAfterResponseUpdate} from response]\n`);
      console.log(`Assistant: ${result.response}\n`);
    } catch (err) {
      console.error(`Error: ${err.message}`);
    }

    prompt();
  });
}

prompt();
