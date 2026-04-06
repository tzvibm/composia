#!/usr/bin/env node

import { Command } from 'commander';
import { createEngine } from './engine.js';
import { Knowledge } from './knowledge.js';
import { readFileSync } from 'fs';
import path from 'path';

const DEFAULT_DB = process.env.COMPOSIA_DB || path.join(process.cwd(), '.composia');

async function withKnowledge(opts, fn) {
  const engine = await createEngine(opts.db || DEFAULT_DB);
  const kb = new Knowledge(engine);
  try {
    await fn(kb);
  } finally {
    await engine.close();
  }
}

function json(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

const program = new Command();

// ── Init ─────────────────────────────────────────────────

program
  .command('init')
  .description('Set up Composia in this project')
  .action(async () => {
    const { initProject } = await import('./init.js');
    const { created, config } = initProject();
    if (created.length) {
      console.log('Created:');
      created.forEach(f => console.log(`  ${f}`));
    } else {
      console.log('Composia already initialized.');
    }
    console.log('\nAdd to .claude/settings.json:');
    console.log(JSON.stringify(config, null, 2));
    console.log('\nPut markdown files in .composia/kb/ then run:');
    console.log('  composia ingest');
  });

program
  .name('composia')
  .description('Graph-backed knowledge base for agents')
  .version('2.0.0')
  .option('--db <path>', 'database path', DEFAULT_DB);

// ── Note commands ────────────────────────────────────────

const note = program.command('note').description('Manage notes');

note
  .command('add <id>')
  .description('Create or update a note')
  .option('-t, --title <title>', 'note title')
  .option('-c, --content <content>', 'markdown content (or use --file)')
  .option('-f, --file <path>', 'read content from a markdown file')
  .option('--tags <tags>', 'comma-separated tags')
  .action(async (id, opts, cmd) => {
    const globalOpts = cmd.parent.parent.opts();
    let content = opts.content || '';
    if (opts.file) {
      content = readFileSync(opts.file, 'utf-8');
    }
    const tags = opts.tags ? opts.tags.split(',').map(t => t.trim()) : [];
    await withKnowledge(globalOpts, async (kb) => {
      const note = await kb.saveNote({ id, title: opts.title || id, content, tags });
      json(note);
    });
  });

note
  .command('get <id>')
  .description('Get a note by ID')
  .action(async (id, opts, cmd) => {
    const globalOpts = cmd.parent.parent.opts();
    await withKnowledge(globalOpts, async (kb) => {
      const note = await kb.getNote(id);
      json(note);
    });
  });

note
  .command('rm <id>')
  .description('Delete a note and its links')
  .action(async (id, opts, cmd) => {
    const globalOpts = cmd.parent.parent.opts();
    await withKnowledge(globalOpts, async (kb) => {
      await kb.deleteNote(id);
      console.log(`Deleted: ${id}`);
    });
  });

note
  .command('list')
  .description('List all notes')
  .option('-n, --limit <n>', 'max notes to return', '50')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.parent.parent.opts();
    await withKnowledge(globalOpts, async (kb) => {
      const notes = await kb.listNotes({ limit: parseInt(opts.limit, 10) });
      json(notes.map(n => ({ id: n.id, title: n.title, tags: n.tags })));
    });
  });

// ── Link / Graph commands ────────────────────────────────

const link = program.command('link').description('Query links and graph');

link
  .command('from <id>')
  .description('Show forward links from a note')
  .action(async (id, opts, cmd) => {
    const globalOpts = cmd.parent.parent.opts();
    await withKnowledge(globalOpts, async (kb) => {
      const { forward } = await kb.getLinks(id);
      json(forward);
    });
  });

link
  .command('to <id>')
  .description('Show backlinks to a note')
  .action(async (id, opts, cmd) => {
    const globalOpts = cmd.parent.parent.opts();
    await withKnowledge(globalOpts, async (kb) => {
      const { backlinks } = await kb.getLinks(id);
      json(backlinks);
    });
  });

link
  .command('graph <id>')
  .description('Show local graph around a note')
  .option('-d, --depth <n>', 'traversal depth', '1')
  .action(async (id, opts, cmd) => {
    const globalOpts = cmd.parent.parent.opts();
    await withKnowledge(globalOpts, async (kb) => {
      const graph = await kb.getGraph(id, parseInt(opts.depth, 10));
      json(graph);
    });
  });

// ── Search commands ──────────────────────────────────────

program
  .command('search <query>')
  .description('Search notes by title or content')
  .action(async (query, opts, cmd) => {
    const globalOpts = cmd.parent.opts();
    await withKnowledge(globalOpts, async (kb) => {
      const results = await kb.search(query);
      json(results.map(n => ({ id: n.id, title: n.title, tags: n.tags })));
    });
  });

program
  .command('tag <tag>')
  .description('Find notes by tag')
  .action(async (tag, opts, cmd) => {
    const globalOpts = cmd.parent.opts();
    await withKnowledge(globalOpts, async (kb) => {
      const notes = await kb.findByTag(tag);
      json(notes.map(n => ({ id: n.id, title: n.title })));
    });
  });

// ── Stats ────────────────────────────────────────────────

program
  .command('stats')
  .description('Show database statistics')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.parent.opts();
    await withKnowledge(globalOpts, async (kb) => {
      json(await kb.stats());
    });
  });

// ── Quick commands (for use from Claude CLI or terminal) ─

program
  .command('remember <text...>')
  .description('Quickly save a piece of knowledge (auto-generates ID, parses [[links]] and #tags)')
  .action(async (textParts, opts, cmd) => {
    const globalOpts = cmd.parent.opts();
    const text = textParts.join(' ');
    // Extract title from first sentence or first 60 chars
    const title = text.split(/[.\n]/)[0].slice(0, 80);
    const id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `note-${Date.now().toString(36)}`;
    await withKnowledge(globalOpts, async (kb) => {
      const note = await kb.saveNote({ id, title, content: text });
      console.log(`Saved: ${note.id} (${note.tags.length} tags, links auto-indexed)`);
    });
  });

program
  .command('recall <query...>')
  .description('Search the knowledge graph for relevant notes')
  .action(async (queryParts, opts, cmd) => {
    const globalOpts = cmd.parent.opts();
    const query = queryParts.join(' ');
    await withKnowledge(globalOpts, async (kb) => {
      const results = await kb.search(query);
      if (results.length === 0) {
        console.log('No matching notes found.');
        return;
      }
      for (const n of results.slice(0, 10)) {
        console.log(`\n--- ${n.title} [${n.id}] ${n.tags?.map(t => '#' + t).join(' ') || ''}`);
        console.log(n.content?.slice(0, 300));
      }
      if (results.length > 10) console.log(`\n... and ${results.length - 10} more`);
    });
  });

program
  .command('context <id>')
  .description('Show a note with its links and backlinks — full context')
  .action(async (id, opts, cmd) => {
    const globalOpts = cmd.parent.opts();
    await withKnowledge(globalOpts, async (kb) => {
      const note = await kb.getNote(id);
      const { forward, backlinks } = await kb.getLinks(id);
      console.log(`\n# ${note.title}`);
      console.log(`Tags: ${note.tags?.map(t => '#' + t).join(' ') || 'none'}`);
      console.log(`Updated: ${note.updated}\n`);
      console.log(note.content);
      if (forward.length) {
        console.log(`\n→ Links to: ${forward.map(l => l.target).join(', ')}`);
      }
      if (backlinks.length) {
        console.log(`← Linked from: ${backlinks.map(l => l.source).join(', ')}`);
      }
    });
  });

// ── Export / Import ──────────────────────────────────────

program
  .command('export')
  .description('Export knowledge graph to JSON (pipe to file)')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.parent.opts();
    const engine = await createEngine(globalOpts.db || DEFAULT_DB);
    const kb = new (await import('./knowledge.js')).Knowledge(engine);
    const notes = await kb.listNotes({ limit: 1000000 });
    const dump = [];
    for (const note of notes) {
      const { forward } = await kb.getLinks(note.id);
      dump.push({ ...note, _links: forward.map(l => l.target) });
    }
    console.log(JSON.stringify(dump, null, 2));
    await engine.close();
  });

program
  .command('import <file>')
  .description('Import knowledge graph from JSON export')
  .action(async (file, opts, cmd) => {
    const globalOpts = cmd.parent.opts();
    const { readFileSync } = await import('fs');
    const data = JSON.parse(readFileSync(file, 'utf-8'));
    const engine = await createEngine(globalOpts.db || DEFAULT_DB);
    const kb = new (await import('./knowledge.js')).Knowledge(engine);
    let count = 0;
    for (const note of data) {
      await kb.saveNote({ id: note.id, title: note.title, content: note.content, tags: note.tags || [] });
      count++;
    }
    console.log(`Imported ${count} notes`);
    await engine.close();
  });

// ── Ingest markdown folder ──────────────────────────────

program
  .command('ingest [dir]')
  .description('Ingest a folder of .md files into the graph (default: .composia/kb/)')
  .action(async (dir, opts, cmd) => {
    const globalOpts = cmd.parent.opts();
    const { readdirSync, readFileSync, statSync } = await import('fs');
    const targetDir = dir || path.join(process.cwd(), '.composia', 'kb');
    const engine = await createEngine(globalOpts.db || DEFAULT_DB);
    const kb = new (await import('./knowledge.js')).Knowledge(engine);
    const { slugify } = await import('./parser.js');

    function walk(d) {
      const files = [];
      for (const entry of readdirSync(d)) {
        const full = path.join(d, entry);
        if (statSync(full).isDirectory()) {
          files.push(...walk(full));
        } else if (entry.endsWith('.md')) {
          files.push(full);
        }
      }
      return files;
    }

    const files = walk(targetDir);
    let count = 0;
    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      const rel = path.relative(targetDir, file).replace(/\.md$/, '');
      const id = slugify(rel.replace(/[\\/]/g, '-'));
      const title = rel.split(/[\\/]/).pop();
      await kb.saveNote({ id, title, content });
      count++;
    }
    console.log(`Ingested ${count} markdown files from ${targetDir}`);
    await engine.close();
  });

program.parse();
