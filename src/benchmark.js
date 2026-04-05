#!/usr/bin/env node

/**
 * Composia Benchmark Suite
 *
 * Compares Composia (RocksDB graph) vs File-Based (Obsidian-style) approach
 * across multiple operations at scale.
 *
 * Measures: startup, write, local graph traversal, backlinks, search, memory
 */

import { createEngine } from './engine.js';
import { Knowledge } from './knowledge.js';
import { rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import path from 'path';

const COMPOSIA_DB = path.join(process.cwd(), '.composia-bench');
const FILES_DIR = path.join(process.cwd(), '.filebench');

// ── Helpers ─────────────────────────────────────────────

function hrMs(start) {
  const [s, ns] = process.hrtime(start);
  return (s * 1000 + ns / 1e6).toFixed(2);
}

function memMB() {
  return (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
}

function slugify(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Generate a realistic note with random wikilinks to other notes
function generateNote(id, allIds) {
  const linkCount = 3 + Math.floor(Math.random() * 8); // 3-10 links per note
  const links = [];
  for (let i = 0; i < linkCount; i++) {
    const target = allIds[Math.floor(Math.random() * allIds.length)];
    if (target !== id) links.push(target);
  }
  const uniqueLinks = [...new Set(links)];

  const content = [
    `# Note ${id}`,
    '',
    `This is note ${id}. It contains information about topic ${id}.`,
    '',
    uniqueLinks.map(l => `Related to [[${l}]] which is important.`).join('\n'),
    '',
    `#tag-${id.slice(0, 3)} #benchmark`,
  ].join('\n');

  return { id, title: `Note ${id}`, content, links: uniqueLinks };
}

// ── File-Based Approach (simulates Obsidian) ────────────

class FileBased {
  constructor(dir) {
    this.dir = dir;
  }

  setup() {
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
  }

  writeNote(note) {
    writeFileSync(path.join(this.dir, `${note.id}.md`), note.content);
  }

  // Must read + parse ALL files to build graph (what Obsidian does on startup)
  buildGraph() {
    const files = readdirSync(this.dir).filter(f => f.endsWith('.md'));
    const graph = { forward: {}, backward: {} };

    for (const file of files) {
      const id = file.replace('.md', '');
      const content = readFileSync(path.join(this.dir, file), 'utf-8');
      const links = [];
      const re = /\[\[([^\]|#]+?)(?:[|#][^\]]*?)?\]\]/g;
      let match;
      while ((match = re.exec(content)) !== null) {
        links.push(match[1].trim());
      }
      graph.forward[id] = links;
      for (const target of links) {
        if (!graph.backward[target]) graph.backward[target] = [];
        graph.backward[target].push(id);
      }
    }

    return { graph, fileCount: files.length };
  }

  // Local graph: must build entire graph first, then filter
  getLocalGraph(id, depth = 2) {
    const { graph } = this.buildGraph(); // Must rebuild every time
    const visited = new Set();
    const nodes = [];
    const edges = [];

    const traverse = (nodeId, d) => {
      if (visited.has(nodeId) || d > depth) return;
      visited.add(nodeId);
      nodes.push(nodeId);
      for (const target of (graph.forward[nodeId] || [])) {
        edges.push({ source: nodeId, target });
        traverse(target, d + 1);
      }
      for (const source of (graph.backward[nodeId] || [])) {
        edges.push({ source, target: nodeId });
        traverse(source, d + 1);
      }
    };

    traverse(id, 0);
    return { nodes, edges };
  }

  getBacklinks(id) {
    const { graph } = this.buildGraph();
    return graph.backward[id] || [];
  }

  search(query) {
    const files = readdirSync(this.dir).filter(f => f.endsWith('.md'));
    const results = [];
    const q = query.toLowerCase();
    for (const file of files) {
      const content = readFileSync(path.join(this.dir, file), 'utf-8');
      if (content.toLowerCase().includes(q)) {
        results.push(file.replace('.md', ''));
      }
    }
    return results;
  }

  cleanup() {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

// ── Run Benchmarks ──────────────────────────────────────

async function runBenchmark(noteCount) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  BENCHMARK: ${noteCount.toLocaleString()} notes`);
  console.log(`${'='.repeat(60)}\n`);

  // Generate test data
  const allIds = Array.from({ length: noteCount }, (_, i) => `note-${String(i).padStart(6, '0')}`);
  const notes = allIds.map(id => generateNote(id, allIds));
  const middleId = allIds[Math.floor(allIds.length / 2)];
  const searchTerm = 'topic note-000050';

  const results = {};

  // ── 1. WRITE SPEED ────────────────────────────────────

  // Composia
  rmSync(COMPOSIA_DB, { recursive: true, force: true });
  const engine = await createEngine(COMPOSIA_DB);
  const kb = new Knowledge(engine);

  const memBefore = memMB();
  let t = process.hrtime();
  for (const note of notes) {
    await kb.saveNote(note);
  }
  results.composiaWrite = hrMs(t);
  const composiaMemAfter = memMB();

  // File-based
  const fb = new FileBased(FILES_DIR);
  fb.setup();
  t = process.hrtime();
  for (const note of notes) {
    fb.writeNote(note);
  }
  results.fileWrite = hrMs(t);

  console.log('WRITE (all notes):');
  console.log(`  Composia:   ${results.composiaWrite}ms`);
  console.log(`  File-based: ${results.fileWrite}ms`);
  console.log();

  // ── 2. STARTUP / GRAPH BUILD ──────────────────────────

  // Composia: close and reopen (simulates cold start)
  await engine.close();
  t = process.hrtime();
  const engine2 = await createEngine(COMPOSIA_DB);
  const kb2 = new Knowledge(engine2);
  // Do a single read to confirm it's ready
  await kb2.getNote(middleId);
  results.composiaStartup = hrMs(t);

  // File-based: must read and parse ALL files to build graph
  t = process.hrtime();
  const { fileCount } = fb.buildGraph();
  results.fileStartup = hrMs(t);

  console.log('STARTUP (cold open → first query ready):');
  console.log(`  Composia:   ${results.composiaStartup}ms (open DB + 1 read)`);
  console.log(`  File-based: ${results.fileStartup}ms (read & parse ${fileCount} files)`);
  console.log();

  // ── 3. LOCAL GRAPH TRAVERSAL ──────────────────────────

  // Composia
  t = process.hrtime();
  const composiaGraph = await kb2.getGraph(middleId, 2);
  results.composiaLocalGraph = hrMs(t);

  // File-based
  t = process.hrtime();
  const fileGraph = fb.getLocalGraph(middleId, 2);
  results.fileLocalGraph = hrMs(t);

  console.log(`LOCAL GRAPH (depth=2 from "${middleId}"):`);
  console.log(`  Composia:   ${results.composiaLocalGraph}ms (${composiaGraph.nodes.length} nodes, ${composiaGraph.edges.length} edges)`);
  console.log(`  File-based: ${results.fileLocalGraph}ms (${fileGraph.nodes.length} nodes, ${fileGraph.edges.length} edges)`);
  console.log();

  // ── 4. BACKLINKS ──────────────────────────────────────

  // Composia
  t = process.hrtime();
  const composiaBacklinks = await engine2.getBacklinks(middleId);
  results.composiaBacklinks = hrMs(t);

  // File-based
  t = process.hrtime();
  const fileBacklinks = fb.getBacklinks(middleId);
  results.fileBacklinks = hrMs(t);

  console.log(`BACKLINKS for "${middleId}":`);
  console.log(`  Composia:   ${results.composiaBacklinks}ms (${composiaBacklinks.length} backlinks)`);
  console.log(`  File-based: ${results.fileBacklinks}ms (${fileBacklinks.length} backlinks) — must rebuild full graph`);
  console.log();

  // ── 5. SEARCH ─────────────────────────────────────────

  // Composia
  t = process.hrtime();
  const composiaSearch = await kb2.search(searchTerm);
  results.composiaSearch = hrMs(t);

  // File-based
  t = process.hrtime();
  const fileSearch = fb.search(searchTerm);
  results.fileSearch = hrMs(t);

  console.log(`SEARCH for "${searchTerm}":`);
  console.log(`  Composia:   ${results.composiaSearch}ms (${composiaSearch.length} results)`);
  console.log(`  File-based: ${results.fileSearch}ms (${fileSearch.length} results)`);
  console.log();

  // ── 6. MEMORY ─────────────────────────────────────────

  console.log('MEMORY (heap used):');
  console.log(`  Before:     ${memBefore}MB`);
  console.log(`  After:      ${composiaMemAfter}MB`);
  console.log(`  Note: Composia uses memory-mapped I/O — data lives in OS page cache, not JS heap`);
  console.log();

  // ── SUMMARY TABLE ─────────────────────────────────────

  console.log(`${'─'.repeat(60)}`);
  console.log('SUMMARY (lower is better):');
  console.log(`${'─'.repeat(60)}`);
  console.log(`${'Operation'.padEnd(25)} ${'Composia'.padEnd(15)} ${'File-based'.padEnd(15)} ${'Winner'.padEnd(10)}`);
  console.log(`${'─'.repeat(60)}`);

  const rows = [
    ['Write all', results.composiaWrite, results.fileWrite],
    ['Cold startup', results.composiaStartup, results.fileStartup],
    ['Local graph (d=2)', results.composiaLocalGraph, results.fileLocalGraph],
    ['Backlinks', results.composiaBacklinks, results.fileBacklinks],
    ['Search', results.composiaSearch, results.fileSearch],
  ];

  for (const [op, c, f] of rows) {
    const cVal = parseFloat(c);
    const fVal = parseFloat(f);
    const winner = cVal < fVal ? 'Composia' : cVal > fVal ? 'File-based' : 'Tie';
    const ratio = cVal < fVal ? `${(fVal/cVal).toFixed(1)}x faster` : `${(cVal/fVal).toFixed(1)}x slower`;
    console.log(`${op.padEnd(25)} ${(c+'ms').padEnd(15)} ${(f+'ms').padEnd(15)} ${winner} (${ratio})`);
  }

  console.log(`${'─'.repeat(60)}\n`);

  // Cleanup
  await engine2.close();
  rmSync(COMPOSIA_DB, { recursive: true, force: true });
  fb.cleanup();

  return results;
}

// ── Main ────────────────────────────────────────────────

const sizes = [1000, 5000, 10000];
const count = parseInt(process.argv[2] || '0', 10);

if (count > 0) {
  await runBenchmark(count);
} else {
  for (const size of sizes) {
    await runBenchmark(size);
  }
}
