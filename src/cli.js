#!/usr/bin/env node

import { Command } from 'commander';
import { createEngine } from './engine.js';
import { Knowledge } from './knowledge.js';
import { readFileSync } from 'fs';
import path from 'path';

const DEFAULT_DB = process.env.COMPOSIA_DB || path.join(process.cwd(), '.composia', 'db');

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
    console.log('\nWorkflow:');
    console.log('  1. Put .md files in .composia/kb/  (committed to git)');
    console.log('  2. Run: composia build             (builds RocksDB locally, like npm install)');
    console.log('  3. Teammates: git pull && composia build');
    console.log('  4. After MCP/hook writes: composia sync  (writes new notes back to kb/)');
  });

program
  .name('composia')
  .description('Graph-backed knowledge base for agents')
  .version('2.0.0')
  .option('--db <path>', 'database path', DEFAULT_DB);

// ── Config ──────────────────────────────────────────────

const config = program.command('config').description('Manage Composia configuration');

config
  .command('set <key> <value>')
  .description('Set a config value (stored in .composia/config.json)')
  .action(async (key, value) => {
    const { saveConfig } = await import('./summarizer.js');
    saveConfig({ [key]: value });
    console.log(`Set ${key} = ${key.includes('key') ? value.slice(0, 8) + '...' : value}`);
  });

config
  .command('get [key]')
  .description('Show config values')
  .action(async (key) => {
    const { loadConfig } = await import('./summarizer.js');
    const cfg = loadConfig();
    if (key) {
      const val = cfg[key];
      if (val) {
        console.log(key.includes('key') ? val.slice(0, 8) + '...' + ' (hidden)' : val);
      } else {
        console.log(`Not set. Use: composia config set ${key} <value>`);
      }
    } else {
      for (const [k, v] of Object.entries(cfg)) {
        console.log(`  ${k} = ${k.includes('key') ? String(v).slice(0, 8) + '...' : v}`);
      }
      if (Object.keys(cfg).length === 0) console.log('No config set. Try: composia config set api_key <your-anthropic-key>');
    }
  });

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

// ── Schema ──────────────────────────────────────────────

const schema = program.command('schema').description('Manage property schema');

schema
  .command('generate')
  .description('Auto-generate schema.json from existing notes')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.parent.parent.opts();
    const { Schema } = await import('./schema.js');
    const engine = await createEngine(globalOpts.db || DEFAULT_DB);
    const generated = await Schema.generateFromNotes(engine);
    const schemaPath = path.join(process.cwd(), '.composia', 'schema.json');
    const { writeFileSync, mkdirSync } = await import('fs');
    mkdirSync(path.dirname(schemaPath), { recursive: true });
    writeFileSync(schemaPath, JSON.stringify(generated, null, 2));
    console.log(`Schema generated: ${Object.keys(generated.fields).length} fields`);
    console.log(`Saved to: ${schemaPath}`);
    console.log('Edit to add aliases and adjust types.');
    await engine.close();
  });

schema
  .command('show')
  .description('Show current schema')
  .action(async () => {
    const { loadSchema } = await import('./schema.js');
    const s = loadSchema();
    if (Object.keys(s.fields).length === 0) {
      console.log('No schema defined. Run: composia schema generate');
      return;
    }
    json(s.fields);
  });

// ── Garbage Collection ──────────────────────────────────

program
  .command('gc')
  .description('Find and archive stale, low-relevance notes')
  .option('--older-than <days>', 'minimum age in days', '30')
  .option('--min-score <score>', 'archive notes with score below this', '3')
  .option('--dry-run', 'show what would be archived without doing it')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.parent.opts();
    await withKnowledge(globalOpts, async (kb) => {
      const result = await kb.archiveStale({
        olderThan: parseInt(opts.olderThan, 10),
        minScore: parseInt(opts.minScore, 10),
        dryRun: opts.dryRun,
      });
      if (opts.dryRun) {
        console.log(`Would archive ${result.wouldArchive} notes:`);
        for (const n of result.notes) {
          console.log(`  ${n.id} (score: ${n.score}, age: ${n.ageDays}d, connections: ${n.connections})`);
        }
      } else {
        console.log(`Archived ${result.archived} stale notes (tagged #archived)`);
      }
    });
  });

// ── Summarize ───────────────────────────────────────────

program
  .command('summarize')
  .description('Generate LLM summaries for all notes (requires ANTHROPIC_API_KEY or OPENAI_API_KEY)')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.parent.opts();
    const { createSummarizer, enhanceAll } = await import('./summarizer.js');
    const summarizer = createSummarizer();
    if (!summarizer) {
      console.error('No API key found. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.');
      process.exit(1);
    }
    const engine = await createEngine(globalOpts.db || DEFAULT_DB);
    console.log('Generating LLM summaries...');
    const result = await enhanceAll(engine, summarizer, {
      onProgress: (done, total, failed) => {
        process.stdout.write(`\r  ${done}/${total} summarized${failed ? ` (${failed} failed)` : ''}`);
      },
    });
    console.log(`\nDone: ${result.enhanced} enhanced, ${result.failed} failed, ${result.total} total`);
    await engine.close();
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
  .description('Quickly save a piece of knowledge (writes to kb/ + RocksDB)')
  .action(async (textParts, opts, cmd) => {
    const globalOpts = cmd.parent.opts();
    const { mkdirSync, writeFileSync } = await import('fs');
    const text = textParts.join(' ');
    const title = text.split(/[.\n]/)[0].slice(0, 80);
    const id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `note-${Date.now().toString(36)}`;

    // Write to kb/ file FIRST (if this fails, nothing in DB changed)
    const kbDir = path.join(process.cwd(), '.composia', 'kb');
    mkdirSync(kbDir, { recursive: true });
    writeFileSync(path.join(kbDir, `${id}.md`), text);

    // Then write to RocksDB
    await withKnowledge(globalOpts, async (kb) => {
      await kb.saveNote({ id, title, content: text });
    });
    console.log(`Saved: ${id} (to .composia/kb/${id}.md + db)`);
  });

program
  .command('ask <query...>')
  .alias('recall')
  .description('Ask a question — traverses the graph with semantic + keyword + graph search')
  .option('--no-trace', 'hide reasoning trace')
  .action(async (queryParts, opts, cmd) => {
    const globalOpts = cmd.parent.opts();
    const query = queryParts.join(' ');
    const showTrace = opts.trace !== false;

    // Try viewer API first (avoids DB lock conflict)
    try {
      const viewerRes = await fetch(`http://localhost:3333/api/recall?q=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(2000) });
      if (viewerRes.ok) {
        const result = await viewerRes.json();
        if (result.answer) {
          if (showTrace && result.trace) {
            for (const step of result.trace) console.log(`\x1b[2m• ${step.message}\x1b[0m`);
            console.log('');
          }
          console.log(`\x1b[1m${result.answer}\x1b[0m`);
          if (result.notes?.length) console.log(`\n\x1b[2mBased on ${result.notes.length} nodes\x1b[0m`);
          return;
        }
      }
    } catch { /* viewer not running, use direct DB access */ }

    await withKnowledge(globalOpts, async (kb) => {
      const { createResolver } = await import('./resolve.js');
      const resolver = createResolver(kb);

      if (resolver) {
        const dim = '\x1b[2m';
        const cyan = '\x1b[36m';
        const yellow = '\x1b[33m';
        const green = '\x1b[32m';
        const reset = '\x1b[0m';
        const bold = '\x1b[1m';

        const result = await resolver.resolve(query, {
          onTrace: showTrace ? (step) => {
            const icon = { context: '🔍', strategy: '🧠', execute: '⚡', drill: '🔬', synthesize: '📝', done: '✅' }[step.phase] || '•';
            console.log(`${dim}${icon} ${step.message}${reset}`);
            if (step.strategies) {
              for (const s of step.strategies) console.log(`${dim}   → ${cyan}${s}${reset}`);
            }
            if (step.found?.length) {
              console.log(`${dim}   found: ${yellow}${step.found.slice(0, 8).join(', ')}${step.found.length > 8 ? '...' : ''}${reset}`);
            }
            if (step.drillTargets) {
              console.log(`${dim}   drilling: ${green}${step.drillTargets.join(', ')}${reset}`);
            }
          } : undefined,
        });

        if (result.answer) {
          if (showTrace) console.log('');
          console.log(`${bold}${result.answer}${reset}`);
          if (result.notes?.length) {
            console.log(`\n${dim}Based on ${result.notes.length} nodes: ${result.notes.slice(0, 10).map(n => n.id).join(', ')}${reset}`);
          }
          return;
        }
      }

      // Fallback to keyword search
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

// ── Rules (natural English directives for Claude) ───────

const rules = program.command('rules').description('Manage rules that Claude follows in this project');

rules
  .command('add <rule...>')
  .description('Add a rule in plain English (writes to kb/ + RocksDB)')
  .action(async (ruleParts, opts, cmd) => {
    const globalOpts = cmd.parent.parent.opts();
    const { mkdirSync, writeFileSync, readFileSync, existsSync } = await import('fs');
    const rule = ruleParts.join(' ');

    // Update kb/ file (source of truth for git)
    const kbDir = path.join(process.cwd(), '.composia', 'kb');
    mkdirSync(kbDir, { recursive: true });
    const rulesFile = path.join(kbDir, 'rules.md');
    let content;
    if (existsSync(rulesFile)) {
      content = readFileSync(rulesFile, 'utf-8');
    } else {
      content = '# Composia Rules\n\n';
    }
    content = content.trimEnd() + `\n- ${rule}\n`;
    writeFileSync(rulesFile, content);

    // Update RocksDB
    await withKnowledge(globalOpts, async (kb) => {
      await kb.saveNote({
        id: 'composia-rules',
        title: 'Composia Rules',
        content,
        tags: ['rules', 'system'],
      });
    });
    console.log(`Rule added: "${rule}" (saved to .composia/kb/rules.md)`);
  });

rules
  .command('list')
  .description('Show all rules')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.parent.parent.opts();
    await withKnowledge(globalOpts, async (kb) => {
      try {
        const note = await kb.getNote('composia-rules');
        console.log(note.content);
      } catch {
        console.log('No rules configured yet. Add one with: composia rules add "your rule"');
      }
    });
  });

rules
  .command('rm <index>')
  .description('Remove a rule by its number (1-based)')
  .action(async (index, opts, cmd) => {
    const globalOpts = cmd.parent.parent.opts();
    const idx = parseInt(index, 10);
    await withKnowledge(globalOpts, async (kb) => {
      const note = await kb.getNote('composia-rules');
      const lines = note.content.split('\n');
      let ruleCount = 0;
      const newLines = lines.filter(line => {
        if (line.trim().match(/^[-*•]\s+.+$/) || line.trim().match(/^\d+\.\s+.+$/)) {
          ruleCount++;
          return ruleCount !== idx;
        }
        return true;
      });
      await kb.saveNote({
        id: 'composia-rules',
        title: 'Composia Rules',
        content: newLines.join('\n'),
        tags: ['rules', 'system'],
      });
      console.log(`Rule #${idx} removed.`);
    });
  });

// ── Property Index Queries ───────────────────────────────

program
  .command('query <field> <value>')
  .description('Find all notes where a property field equals a value')
  .action(async (field, value, opts, cmd) => {
    const globalOpts = cmd.parent.opts();
    await withKnowledge(globalOpts, async (kb) => {
      const notes = await kb.queryByProperty(field, value);
      if (notes.length === 0) { console.log(`No notes with ${field} = ${value}`); return; }
      json(notes.map(n => ({ id: n.id, title: n.title, [field]: n.properties?.[field] })));
    });
  });

program
  .command('field <field>')
  .description('Show all unique values for a property field across the graph')
  .action(async (field, opts, cmd) => {
    const globalOpts = cmd.parent.opts();
    await withKnowledge(globalOpts, async (kb) => {
      const values = await kb.getFieldValues(field);
      for (const [value, noteIds] of Object.entries(values)) {
        console.log(`  ${field}=${value}  (${noteIds.length} notes: ${noteIds.slice(0, 5).join(', ')}${noteIds.length > 5 ? '...' : ''})`);
      }
    });
  });

// ── Temporal / History ──────────────────────────────────

program
  .command('history <id>')
  .description('Show version history of a note')
  .option('-n, --limit <n>', 'max versions', '10')
  .action(async (id, opts, cmd) => {
    const globalOpts = cmd.parent.opts();
    await withKnowledge(globalOpts, async (kb) => {
      const versions = await kb.getHistory(id, { limit: parseInt(opts.limit, 10) });
      if (versions.length === 0) { console.log('No history found.'); return; }
      for (const v of versions) {
        console.log(`  ${v._snapshot_at}  "${v.title}"  [${v.tags?.join(', ') || ''}]`);
      }
    });
  });

program
  .command('changes')
  .description('Show recent changes across the entire graph')
  .option('-n, --limit <n>', 'max changes', '20')
  .option('--since <timestamp>', 'only changes after this ISO timestamp')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.parent.opts();
    await withKnowledge(globalOpts, async (kb) => {
      const changes = await kb.getRecentChanges({ since: opts.since, limit: parseInt(opts.limit, 10) });
      for (const c of changes) {
        console.log(`  ${c._snapshot_at}  ${c.id}  "${c.title}"`);
      }
      console.log(`\n${changes.length} changes`);
    });
  });

program
  .command('snapshot <label>')
  .description('Save a full context snapshot (use before clearing context)')
  .action(async (label, opts, cmd) => {
    const globalOpts = cmd.parent.opts();
    await withKnowledge(globalOpts, async (kb) => {
      const result = await kb.saveContextSnapshot(label);
      console.log(`Snapshot "${label}" saved: ${result.noteCount} notes at ${result.timestamp}`);
    });
  });

program
  .command('snapshots')
  .description('List all saved context snapshots')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.parent.opts();
    await withKnowledge(globalOpts, async (kb) => {
      const list = await kb.listSnapshots();
      if (list.length === 0) { console.log('No snapshots.'); return; }
      json(list);
    });
  });

// ── Triggers ────────────────────────────────────────────

const trigger = program.command('trigger').description('Manage reactive triggers');

trigger
  .command('add <id>')
  .description('Add a trigger: when <field> <op> <value> → <action>')
  .requiredOption('--field <field>', 'property field to watch')
  .requiredOption('--op <op>', 'operator: eq, neq, set, changed')
  .option('--value <value>', 'value to compare (for eq/neq)')
  .requiredOption('--action <action>', 'action: tag, link, log')
  .option('--tag <tag>', 'tag to add (for action=tag)')
  .option('--target <target>', 'note to link to (for action=link)')
  .option('--message <message>', 'log message (for action=log)')
  .action(async (id, opts, cmd) => {
    const globalOpts = cmd.parent.parent.opts();
    await withKnowledge(globalOpts, async (kb) => {
      await kb.addTrigger(id, {
        field: opts.field,
        op: opts.op,
        value: opts.value,
        action: opts.action,
        actionArgs: { tag: opts.tag, target: opts.target, message: opts.message },
      });
      console.log(`Trigger "${id}" added: when ${opts.field} ${opts.op} ${opts.value || ''} → ${opts.action}`);
    });
  });

trigger
  .command('rm <id>')
  .description('Remove a trigger')
  .action(async (id, opts, cmd) => {
    const globalOpts = cmd.parent.parent.opts();
    await withKnowledge(globalOpts, async (kb) => {
      await kb.removeTrigger(id);
      console.log(`Trigger "${id}" removed.`);
    });
  });

trigger
  .command('list')
  .description('List all triggers')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.parent.parent.opts();
    await withKnowledge(globalOpts, async (kb) => {
      const triggers = await kb.listTriggers();
      if (triggers.length === 0) { console.log('No triggers.'); return; }
      json(triggers);
    });
  });

// ── Build / Sync (git-native team sharing) ──────────────

program
  .command('build')
  .description('Build RocksDB graph from .composia/kb/ markdown files (like npm install)')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.parent.opts();
    const kbDir = path.join(process.cwd(), '.composia', 'kb');
    const dbPath = globalOpts.db || DEFAULT_DB;
    const { build } = await import('./sync.js');
    const result = await build(kbDir, dbPath);
    console.log(`Built: ${result.notes} notes, ${result.links} links`);
  });

program
  .command('sync')
  .description('Write RocksDB notes back to .composia/kb/ as markdown files')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.parent.opts();
    const kbDir = path.join(process.cwd(), '.composia', 'kb');
    const dbPath = globalOpts.db || DEFAULT_DB;
    const { syncToFiles } = await import('./sync.js');
    const result = await syncToFiles(kbDir, dbPath);
    console.log(`Synced: ${result.written} written, ${result.skipped} unchanged, ${result.total} total`);
  });

program
  .command('ingest [dir]')
  .description('Alias for build — ingest markdown files into the graph')
  .action(async (dir, opts, cmd) => {
    const globalOpts = cmd.parent.opts();
    const kbDir = dir || path.join(process.cwd(), '.composia', 'kb');
    const dbPath = globalOpts.db || DEFAULT_DB;
    const { build } = await import('./sync.js');
    const result = await build(kbDir, dbPath);
    console.log(`Ingested: ${result.notes} notes, ${result.links} links`);
  });

// ── Map (codebase → self-navigating knowledge graph) ────

program
  .command('map <dir>')
  .description('Map a codebase directory into a self-navigating knowledge graph')
  .option('-p, --prefix <prefix>', 'ID prefix for map nodes', 'map')
  .action(async (dir, opts, cmd) => {
    const globalOpts = cmd.parent.opts();
    const { mapDirectory } = await import('./mapper.js');
    await withKnowledge(globalOpts, async (kb) => {
      console.log(`Mapping ${dir}...`);
      const result = await mapDirectory(dir, kb, {
        prefix: opts.prefix,
        onProgress: (done, total, failed) => {
          process.stdout.write(`\r  Summarizing: ${done}/${total} nodes${failed ? ` (${failed} failed)` : ''}`);
        },
      });
      if (result.summarized > 0) process.stdout.write('\n');
      console.log(`\nMapped: ${result.notes} nodes, ${result.links} links, ${result.constructs} constructs`);
      if (result.summarized > 0) {
        console.log(`Summarized: ${result.summarized} nodes (LLM)`);
      } else {
        console.log(`No API key — using deterministic summaries. For LLM: composia config set api_key <key>`);
      }
      if (result.indexed > 0) {
        console.log(`Indexed: ${result.indexed} vectors (semantic search ready)`);
      }
      console.log(`\nRoot node: ${result.root}`);
      console.log(`  composia view           # browse in browser`);
      console.log(`  composia context ${result.root}`);
    });
  });

// ── Embed (vector index) ────────────────────────────────

program
  .command('embed')
  .description('Build vector index for semantic search')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.parent.opts();
    const { VectorIndex } = await import('./vectors.js');
    const engine = await createEngine(globalOpts.db || DEFAULT_DB);
    const vecIndex = new VectorIndex(engine);
    console.log('Building vector index...');
    const result = await vecIndex.buildIndex();
    console.log(`Indexed: ${result.indexed} notes, vocabulary: ${result.vocabSize} terms`);
    await engine.close();
  });

// ── Semantic search ─────────────────────────────────────

program
  .command('semantic <query...>')
  .description('Semantic search — find notes by meaning, not just keywords')
  .option('-n, --limit <n>', 'max results', '10')
  .action(async (queryParts, opts, cmd) => {
    const globalOpts = cmd.parent.opts();
    const query = queryParts.join(' ');
    const { VectorIndex } = await import('./vectors.js');
    const engine = await createEngine(globalOpts.db || DEFAULT_DB);
    const vecIndex = new VectorIndex(engine);
    const results = await vecIndex.search(query, { limit: parseInt(opts.limit, 10) });
    if (results.length === 0) {
      console.log('No results. Run `composia embed` first to build the vector index.');
    } else {
      for (const r of results) {
        console.log(`  ${r.score.toFixed(3)}  ${r.id}  "${r.title}"  ${r.tags?.map(t => '#' + t).join(' ') || ''}`);
        if (r.summary) console.log(`         ${r.summary.slice(0, 120)}`);
      }
    }
    await engine.close();
  });

// ── View (browser-based graph explorer) ─────────────────

program
  .command('view')
  .description('Open an interactive graph browser in your web browser')
  .option('-p, --port <port>', 'server port', '3333')
  .option('--no-open', 'do not auto-open browser')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.parent.opts();
    const dbPath = globalOpts.db || DEFAULT_DB;
    const port = parseInt(opts.port, 10);
    const { startViewer } = await import('./viewer.js');
    const { server } = await startViewer(dbPath, { port });
    if (opts.open !== false) {
      const { exec } = await import('child_process');
      const url = `http://localhost:${port}`;
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      exec(`${opener} ${url}`);
    }
    console.log('Press Ctrl+C to stop.');
  });

// ── Plan (prompt → execution graph) ────────────────────

program
  .command('plan <prompt...>')
  .description('Build an execution plan from a natural language prompt')
  .option('-n, --max-nodes <n>', 'max nodes in plan', '15')
  .action(async (promptParts, opts, cmd) => {
    const globalOpts = cmd.parent.opts();
    const prompt = promptParts.join(' ');
    const { buildPlan } = await import('./prompt-mapper.js');
    await withKnowledge(globalOpts, async (kb) => {
      const result = await buildPlan(kb, prompt, { maxNodes: parseInt(opts.maxNodes, 10) });
      console.log(`\nPlan: ${result.planId}`);
      console.log(`Found ${result.summary.nodeCount} relevant nodes (${result.summary.lowConfidenceCount} low-confidence)\n`);
      for (const node of result.summary.nodes) {
        const conf = node.confidence < 0.5 ? ' [LOW]' : node.confidence < 0.8 ? ' [~]' : '';
        console.log(`  ${node.confidence.toFixed(2)}${conf}  ${node.id}  "${node.title}"`);
        if (node.summary) console.log(`         ${node.summary.slice(0, 120)}`);
      }
      if (result.lowConfidence.length > 0) {
        console.log(`\nLow-confidence nodes need verification:`);
        for (const lc of result.lowConfidence) {
          console.log(`  - ${lc.id} (${lc.confidence.toFixed(2)})`);
        }
      }
      console.log(`\n  composia context ${result.planId}  # view full plan`);
    });
  });

// ── Mapper registry ────────────────────────────────────

const mapper = program.command('mapper').description('Manage domain-specific mappers');

mapper
  .command('list')
  .description('List installed mappers')
  .action(async () => {
    const { loadMappers } = await import('./registry.js');
    const mappers = loadMappers();
    if (mappers.length === 0) {
      console.log('No mappers installed. Add .md files to .composia/mappers/');
      return;
    }
    for (const m of mappers) {
      console.log(`  ${m.domain.padEnd(12)} ${m.id.padEnd(25)} ${m.description || ''}`);
      if (m.filePatterns.length) console.log(`             files: ${m.filePatterns.join(', ')}`);
    }
  });

mapper
  .command('install <source> [filename]')
  .description('Install a mapper from a file path or raw content')
  .action(async (source, filename) => {
    const { installMapper } = await import('./registry.js');
    const name = filename || path.basename(source);
    const result = installMapper(process.cwd(), source, name);
    console.log(`Installed mapper: ${result.installed}`);
  });

// ── Confidence ─────────────────────────────────────────

program
  .command('confidence <id>')
  .description('Log a confidence change on a note')
  .requiredOption('-d, --delta <delta>', 'Confidence change (-1 to 1)')
  .requiredOption('-r, --reason <reason>', 'Why confidence changed')
  .action(async (id, opts, cmd) => {
    const globalOpts = cmd.parent.opts();
    await withKnowledge(globalOpts, async (kb) => {
      const result = await kb.logConfidence(id, parseFloat(opts.delta), opts.reason);
      console.log(`${id}: confidence ${result.confidence.toFixed(2)} (${result.delta > 0 ? '+' : ''}${result.delta})`);
      if (result.triggered) console.log(`  ⚠ Below threshold — needs reevaluation`);
    });
  });

// ── Chat (interactive session with persistent temp graph) ─

program
  .command('chat')
  .description('Interactive session — each turn builds on the session graph')
  .option('--no-trace', 'hide reasoning trace')
  .option('--keep', 'keep session graph on exit (default: cleanup)')
  .option('-p, --port <port>', 'viewer port (0 to disable)', '3333')
  .option('--no-view', 'do not start the browser viewer')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.parent.opts();
    const engine = await createEngine(globalOpts.db || DEFAULT_DB);
    const kb = new Knowledge(engine);
    const sessionId = `session-${Date.now()}`;

    // Start viewer server (same process, same DB handle)
    let viewerServer = null;
    const port = parseInt(opts.port, 10);
    if (port > 0 && opts.view !== false) {
      try {
        const { startViewer } = await import('./viewer.js');
        const viewer = await startViewer(globalOpts.db || DEFAULT_DB, { port, _engine: engine });
        viewerServer = viewer.server;
        const viewUrl = `http://localhost:${port}`;
        const { exec } = await import('child_process');
        const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
        exec(`${opener} ${viewUrl}`);
      } catch (e) {
        // Port may be in use — not fatal
      }
    }

    const dim = '\x1b[2m';
    const cyan = '\x1b[36m';
    const yellow = '\x1b[33m';
    const green = '\x1b[32m';
    const magenta = '\x1b[35m';
    const reset = '\x1b[0m';
    const bold = '\x1b[1m';

    console.log(`${bold}Composia Chat${reset}  ${dim}session: ${sessionId}${reset}`);
    if (viewerServer) console.log(`${dim}Viewer: http://localhost:${port} (Sessions tab updates live)${reset}`);
    console.log(`${dim}Type your prompt. "graph" to see session graph. "exit" to quit.${reset}\n`);

    const { createInterface } = await import('readline');
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    const showTrace = opts.trace !== false;
    let turnCount = 0;

    const prompt = () => rl.question(`${cyan}> ${reset}`, async (input) => {
      input = input.trim();
      if (!input) return prompt();

      // ── Commands ──
      if (input === 'exit' || input === 'quit' || input === '.exit') {
        if (!opts.keep) {
          const result = await kb.cleanupTemp(sessionId);
          if (result.deleted > 0) console.log(`${dim}Cleaned up ${result.deleted} session nodes.${reset}`);
        } else {
          console.log(`${dim}Session graph kept: tag session:${sessionId}${reset}`);
        }
        rl.close();
        if (viewerServer) viewerServer.close();
        await engine.close();
        return;
      }

      if (input === 'graph') {
        const tempIds = await engine.getNotesByTag(`session:${sessionId}`);
        if (tempIds.length === 0) {
          console.log(`${dim}No session nodes yet.${reset}\n`);
          return prompt();
        }

        // Gather session graph state
        const graphState = [];
        for (const id of tempIds) {
          try {
            const note = await engine.getNote(id);
            const { forward } = await kb.getLinks(id);
            const targets = forward.map(l => l.target);
            graphState.push({ id, title: note.title, prompt: note.properties?.prompt, links: targets });
          } catch {}
        }

        // LLM summary of session graph
        const { createResolver } = await import('./resolve.js');
        const resolver = createResolver(kb);
        if (resolver) {
          const graphText = graphState.map(n =>
            `- ${n.title}${n.prompt ? ` (prompt: "${n.prompt}")` : ''}\n  links to: ${n.links.slice(0, 10).join(', ') || 'none'}`
          ).join('\n');
          const summary = await resolver.llm(
            `Summarize this session's exploration graph in 2-4 sentences. What has been explored, what areas have been covered, and what themes connect the nodes?\n\nSession nodes:\n${graphText}`
          );
          console.log(`\n${bold}Session Graph${reset} ${dim}(${tempIds.length} plans, ${graphState.reduce((s, n) => s + n.links.length, 0)} links)${reset}`);
          console.log(`${summary}\n`);
        } else {
          // Fallback: compact dump if no API key
          console.log(`\n${bold}Session Graph${reset} ${dim}(${tempIds.length} nodes)${reset}`);
          for (const n of graphState) {
            console.log(`  ${magenta}${n.title}${reset} ${dim}→ ${n.links.length} links${reset}`);
          }
          console.log('');
        }
        return prompt();
      }

      if (input === 'keep') {
        const tempIds = await engine.getNotesByTag(`session:${sessionId}`);
        for (const id of tempIds) {
          await kb.promoteTemp(id);
        }
        console.log(`${green}Promoted ${tempIds.length} session nodes to permanent.${reset}\n`);
        return prompt();
      }

      // ── Build plan (grows session graph) ──
      turnCount++;
      try {
        const { buildPlan } = await import('./prompt-mapper.js');
        const plan = await buildPlan(kb, input, { sessionId, maxNodes: 15 });
        console.log(`${dim}Plan: ${plan.planId} — ${plan.summary.nodeCount} nodes${plan.summary.lowConfidenceCount ? ` (${plan.summary.lowConfidenceCount} low-confidence)` : ''}${reset}`);

        // Show the plan nodes briefly
        for (const node of plan.summary.nodes.slice(0, 8)) {
          const conf = node.confidence < 0.5 ? ` ${yellow}[LOW]${reset}` : '';
          console.log(`${dim}  ${node.confidence.toFixed(2)}${conf}  ${node.id}  "${node.title}"${reset}`);
        }
        if (plan.summary.nodes.length > 8) {
          console.log(`${dim}  ... and ${plan.summary.nodes.length - 8} more${reset}`);
        }

        // ── Resolve (LLM traverses the graph) ──
        const { createResolver } = await import('./resolve.js');
        const resolver = createResolver(kb);

        if (resolver) {
          const result = await resolver.resolve(input, {
            onTrace: showTrace ? (step) => {
              const icon = { context: '~', strategy: '*', execute: '>', read: '#', synthesize: '+', done: '=' }[step.phase] || '.';
              console.log(`${dim}${icon} ${step.message}${reset}`);
              if (step.strategies) {
                for (const s of step.strategies) console.log(`${dim}   -> ${cyan}${s}${reset}`);
              }
              if (step.found?.length) {
                console.log(`${dim}   found: ${yellow}${step.found.slice(0, 8).join(', ')}${step.found.length > 8 ? '...' : ''}${reset}`);
              }
              if (step.drillTargets) {
                console.log(`${dim}   reading: ${green}${step.drillTargets.join(', ')}${reset}`);
              }
            } : undefined,
          });

          if (result.answer) {
            if (showTrace) console.log('');
            console.log(`${bold}${result.answer}${reset}`);
            if (result.notes?.length) {
              console.log(`\n${dim}Based on ${result.notes.length} nodes${reset}`);
            }
          }
        } else {
          console.log(`\n${yellow}No API key configured. Run: composia config set api_key <key>${reset}`);
          console.log(`${dim}Plan was still built — type "graph" to see session state.${reset}`);
        }
      } catch (e) {
        console.log(`${yellow}Error: ${e.message}${reset}`);
      }

      console.log('');
      prompt();
    });

    prompt();
  });

// ── Cleanup temp nodes ─────────────────────────────────

program
  .command('cleanup')
  .description('Remove all temporary nodes (plans, execution artifacts)')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.parent.opts();
    await withKnowledge(globalOpts, async (kb) => {
      const result = await kb.cleanupTemp();
      console.log(`Cleaned up ${result.deleted} temporary nodes`);
    });
  });

program.parse();
