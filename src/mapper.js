/**
 * Composia Mapper — scans a codebase and builds a self-navigating knowledge graph.
 *
 * Each node in the graph contains:
 *   1. A summary of what it represents
 *   2. An ordered list of [[child]] links to traverse
 *   3. Navigation instructions for an LLM to follow
 *   4. A backlink to parent with context template for returning upward
 *
 * Levels of composability (top-down):
 *   project → directories → files → constructs (classes, interfaces, functions) → methods
 *
 * The graph IS the execution plan. An LLM reads the root node, follows
 * instructions to visit children in order, and backlinks carry completion
 * context upward.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import path from 'path';
import { slugify } from './parser.js';
import { createCodeSummarizer } from './summarizer.js';
import { VectorIndex } from './vectors.js';

const IGNORE = new Set([
  'node_modules', '.git', '.composia', 'dist', 'build', '.next',
  'coverage', '__pycache__', '.venv', 'vendor', '.DS_Store',
]);

const CODE_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java']);

// ── Source code construct extraction ────────────────────

function extractConstructs(content, filePath) {
  const ext = path.extname(filePath);
  if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'].includes(ext)) return extractJS(content);
  if (ext === '.py') return extractPython(content);
  if (ext === '.go') return extractGo(content);
  return [];
}

function extractJS(content) {
  const constructs = [];
  let m;

  // Classes
  const classRe = /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?/gm;
  while ((m = classRe.exec(content)) !== null) {
    const line = lineNum(content, m.index);
    const body = extractBraceBlock(content, m.index);
    constructs.push({
      type: 'class', name: m[1], extends: m[2] || null, line,
      methods: extractJSMethods(body),
    });
  }

  // Standalone functions (not inside classes — approximate by checking indentation)
  const funcRe = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s+(\w+)\s*\(/gm;
  while ((m = funcRe.exec(content)) !== null) {
    if (!isInsideClass(content, m.index, constructs)) {
      constructs.push({ type: 'function', name: m[1], line: lineNum(content, m.index), methods: [] });
    }
  }

  // Exported arrow functions: export const foo = (...) =>
  const arrowRe = /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(?/gm;
  while ((m = arrowRe.exec(content)) !== null) {
    // Check if it's an arrow function (look ahead for =>)
    const rest = content.slice(m.index, m.index + 200);
    if (rest.includes('=>') && !isInsideClass(content, m.index, constructs)) {
      constructs.push({ type: 'function', name: m[1], line: lineNum(content, m.index), methods: [] });
    }
  }

  // TypeScript interfaces
  const ifaceRe = /^(?:export\s+)?interface\s+(\w+)/gm;
  while ((m = ifaceRe.exec(content)) !== null) {
    constructs.push({ type: 'interface', name: m[1], line: lineNum(content, m.index), methods: [] });
  }

  // TypeScript type aliases
  const typeRe = /^(?:export\s+)?type\s+(\w+)\s*(?:<[^>]*>)?\s*=/gm;
  while ((m = typeRe.exec(content)) !== null) {
    constructs.push({ type: 'type', name: m[1], line: lineNum(content, m.index), methods: [] });
  }

  return constructs;
}

function extractJSMethods(classBody) {
  if (!classBody) return [];
  const methods = [];
  const re = /^\s+(?:async\s+)?(?:static\s+)?(?:get\s+|set\s+)?(?:#)?(\w+)\s*\(/gm;
  let m;
  while ((m = re.exec(classBody)) !== null) {
    const skip = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'typeof']);
    if (!skip.has(m[1])) methods.push({ name: m[1] });
  }
  return methods;
}

function extractPython(content) {
  const constructs = [];
  let m;
  const classRe = /^class\s+(\w+)(?:\(([^)]*)\))?:/gm;
  while ((m = classRe.exec(content)) !== null) {
    const line = lineNum(content, m.index);
    const methods = [];
    // Find methods (indented def inside class)
    const afterClass = content.slice(m.index);
    const methodRe = /^\s{2,}def\s+(\w+)\s*\(/gm;
    let mm;
    while ((mm = methodRe.exec(afterClass)) !== null) {
      methods.push({ name: mm[1] });
    }
    constructs.push({ type: 'class', name: m[1], extends: m[2] || null, line, methods });
  }
  const funcRe = /^(?:async\s+)?def\s+(\w+)\s*\(/gm;
  while ((m = funcRe.exec(content)) !== null) {
    if (!isInsideClass(content, m.index, constructs)) {
      constructs.push({ type: 'function', name: m[1], line: lineNum(content, m.index), methods: [] });
    }
  }
  return constructs;
}

function extractGo(content) {
  const constructs = [];
  let m;
  const structRe = /^type\s+(\w+)\s+struct\s*\{/gm;
  while ((m = structRe.exec(content)) !== null) {
    constructs.push({ type: 'class', name: m[1], line: lineNum(content, m.index), methods: [] });
  }
  const ifaceRe = /^type\s+(\w+)\s+interface\s*\{/gm;
  while ((m = ifaceRe.exec(content)) !== null) {
    constructs.push({ type: 'interface', name: m[1], line: lineNum(content, m.index), methods: [] });
  }
  const funcRe = /^func\s+(?:\(\w+\s+\*?(\w+)\)\s+)?(\w+)\s*\(/gm;
  while ((m = funcRe.exec(content)) !== null) {
    if (m[1]) {
      // Method on a struct — add to the struct
      const struct = constructs.find(c => c.name === m[1]);
      if (struct) struct.methods.push({ name: m[2] });
    } else {
      constructs.push({ type: 'function', name: m[2], line: lineNum(content, m.index), methods: [] });
    }
  }
  return constructs;
}

// ── Helpers ─────────────────────────────────────────────

function lineNum(content, index) {
  return content.slice(0, index).split('\n').length;
}

function extractBraceBlock(content, startIndex) {
  const openIdx = content.indexOf('{', startIndex);
  if (openIdx === -1) return '';
  let depth = 0;
  for (let i = openIdx; i < content.length; i++) {
    if (content[i] === '{') depth++;
    else if (content[i] === '}') { depth--; if (depth === 0) return content.slice(openIdx, i + 1); }
  }
  return content.slice(openIdx);
}

function isInsideClass(content, index, constructs) {
  // Check if the index falls within the brace block of any class
  for (const c of constructs) {
    if (c.type !== 'class') continue;
    // Find the class declaration in source
    const classRe = new RegExp(`(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?class\\s+${c.name}\\b`);
    const classMatch = content.match(classRe);
    if (!classMatch) continue;
    const classStart = classMatch.index;
    const openBrace = content.indexOf('{', classStart);
    if (openBrace === -1) continue;
    // Find matching close brace
    let depth = 0;
    for (let i = openBrace; i < content.length; i++) {
      if (content[i] === '{') depth++;
      else if (content[i] === '}') { depth--; if (depth === 0) { if (index > classStart && index < i) return true; break; } }
    }
  }
  return false;
}

// ── Directory tree walker ───────────────────────────────

function walkTree(dir) {
  if (!existsSync(dir)) return { dirs: [], files: [] };
  const dirs = [];
  const files = [];
  for (const entry of readdirSync(dir).sort()) {
    if (IGNORE.has(entry) || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    try {
      const stat = statSync(full);
      if (stat.isDirectory()) {
        dirs.push({ name: entry, path: full, children: walkTree(full) });
      } else if (stat.isFile() && stat.size < 500_000) { // skip huge files
        files.push({ name: entry, path: full, size: stat.size });
      }
    } catch { /* permission denied, etc */ }
  }
  return { dirs, files };
}

function countDescendants(tree) {
  let count = tree.files.length;
  for (const d of tree.dirs) count += countDescendants(d.children) + 1;
  return count;
}

// ── Node ID generation ──────────────────────────────────

function nodeId(prefix, ...parts) {
  return `${prefix}-${slugify(parts.join('-'))}`;
}

// ── Content builders ────────────────────────────────────

function buildTraverseSection(childEntries) {
  if (childEntries.length === 0) return '';
  let s = '## Traverse\n\n';
  s += 'Process each item below in order. Visit the link, process it fully, then return here via its backlink.\n\n';
  for (let i = 0; i < childEntries.length; i++) {
    s += `${i + 1}. [[${childEntries[i].id}]] — ${childEntries[i].label}\n`;
  }
  s += `\nTotal: ${childEntries.length} items.\n`;
  return s;
}

function buildReturnSection(parentId, nextSiblingId, nodeType, nodeName) {
  if (!parentId) return '';
  let s = '\n## Return\n\n';
  s += `← [[${parentId}]]\n\n`;
  s += `On return, pass context: "${nodeType} \`${nodeName}\` processed. Summary: {describe what you found}."\n\n`;
  if (nextSiblingId) {
    s += `Continue to: [[${nextSiblingId}]]\n`;
  } else {
    s += 'This is the last sibling. Return to parent as complete.\n';
  }
  return s;
}

// ── Main mapper ─────────────────────────────────────────

/**
 * Map a codebase directory into a self-navigating composia graph.
 *
 * @param {string} targetDir - Directory to map
 * @param {Knowledge} kb - Composia knowledge instance
 * @param {object} opts - { prefix: 'map' }
 * @returns {{ root: string, notes: number, links: number, constructs: number }}
 */
export async function mapDirectory(targetDir, kb, opts = {}) {
  const absDir = path.resolve(targetDir);
  const projectName = path.basename(absDir);
  const prefix = opts.prefix || 'map';
  const notes = [];

  const tree = walkTree(absDir);
  const totalItems = countDescendants(tree);

  // Read package.json for project context
  let pkg = null;
  try {
    const pkgPath = path.join(absDir, 'package.json');
    if (existsSync(pkgPath)) {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    } else {
      // Check parent dir (common when mapping src/ inside a project)
      const parentPkg = path.join(absDir, '..', 'package.json');
      if (existsSync(parentPkg)) {
        pkg = JSON.parse(readFileSync(parentPkg, 'utf-8'));
      }
    }
  } catch { /* no package.json */ }

  // ── Recursive builder ──────────────────────────────────

  function buildDir(name, relPath, tree, parentId, siblingIds, myIdx) {
    const id = relPath ? nodeId(prefix, relPath) : nodeId(prefix, name);
    const isRoot = !parentId;
    const level = isRoot ? 'project' : 'directory';

    // Collect child entries for the traverse list
    const childEntries = [];
    const childDirIds = [];
    const childFileIds = [];

    for (const d of tree.dirs) {
      const dRel = relPath ? `${relPath}/${d.name}` : d.name;
      const dId = nodeId(prefix, dRel);
      const desc = countDescendants(d.children);
      childEntries.push({ id: dId, label: `\`${d.name}/\` — directory (${desc} items)` });
      childDirIds.push(dId);
    }
    for (const f of tree.files) {
      const fRel = relPath ? `${relPath}/${f.name}` : f.name;
      const fId = nodeId(prefix, fRel);
      childEntries.push({ id: fId, label: `\`${f.name}\`` });
      childFileIds.push(fId);
    }

    const allChildIds = [...childDirIds, ...childFileIds];
    const nextSibling = siblingIds && myIdx < siblingIds.length - 1 ? siblingIds[myIdx + 1] : null;

    // Summary
    let summary = isRoot
      ? `Project \`${name}\` — ${totalItems} items across ${tree.dirs.length} directories and ${tree.files.length} top-level files.`
      : `Directory \`${name}/\` — ${tree.dirs.length} subdirectories, ${tree.files.length} files.`;

    let content = `# ${isRoot ? 'Project' : 'Directory'}: ${name}\n\n`;
    content += `> **Level:** ${level} | **Path:** \`${relPath || '.'}\`\n\n`;
    content += summary + '\n\n';

    // Add project context from package.json
    if (isRoot && pkg) {
      content += `## Project Info\n\n`;
      if (pkg.description) content += `${pkg.description}\n\n`;
      if (pkg.bin) {
        const bins = typeof pkg.bin === 'string' ? { [pkg.name]: pkg.bin } : pkg.bin;
        content += `### CLI Commands\n\n`;
        content += `This project provides CLI commands. Run via:\n`;
        for (const [cmd, entrypoint] of Object.entries(bins)) {
          content += `- \`npx ${cmd} <command>\` (entry: \`${entrypoint}\`)\n`;
        }
        content += `\n`;
      }
      if (pkg.scripts) {
        content += `### Scripts\n\n`;
        for (const [name, script] of Object.entries(pkg.scripts)) {
          content += `- \`npm run ${name}\` → \`${script}\`\n`;
        }
        content += `\n`;
      }
      if (pkg.dependencies) {
        content += `### Dependencies\n\n`;
        content += Object.keys(pkg.dependencies).join(', ') + '\n\n';
      }
    }
    content += buildTraverseSection(childEntries);
    content += buildReturnSection(parentId, nextSibling, level, name);

    notes.push({
      id, title: name, content,
      tags: ['map', level],
      properties: { type: 'map-node', level, path: relPath || '.', status: 'pending', children_count: allChildIds.length },
    });

    // Recurse into subdirs
    for (let i = 0; i < tree.dirs.length; i++) {
      const d = tree.dirs[i];
      const dRel = relPath ? `${relPath}/${d.name}` : d.name;
      buildDir(d.name, dRel, d.children, id, allChildIds, i);
    }

    // Process files
    for (let i = 0; i < tree.files.length; i++) {
      const f = tree.files[i];
      const fRel = relPath ? `${relPath}/${f.name}` : f.name;
      buildFile(f, fRel, id, allChildIds, tree.dirs.length + i);
    }
  }

  function buildFile(fileInfo, relPath, parentId, siblingIds, myIdx) {
    const id = nodeId(prefix, relPath);
    const ext = path.extname(fileInfo.name);
    const nextSibling = siblingIds && myIdx < siblingIds.length - 1 ? siblingIds[myIdx + 1] : null;

    let fileContent = '';
    try { fileContent = readFileSync(fileInfo.path, 'utf-8'); } catch { /* binary */ }

    const lineCount = fileContent.split('\n').length;
    const constructs = extractConstructs(fileContent, fileInfo.path);

    // Build child entries for constructs
    const childEntries = [];
    for (const c of constructs) {
      const cId = nodeId(prefix, relPath, c.name);
      const icon = c.type === 'class' ? 'class' : c.type === 'interface' ? 'interface' : c.type === 'type' ? 'type' : 'function';
      childEntries.push({ id: cId, label: `${icon} \`${c.name}\`${c.methods?.length ? ` (${c.methods.length} methods)` : ''}` });
    }

    const summary = `\`${fileInfo.name}\` — ${lineCount} lines.${constructs.length ? ` ${constructs.length} constructs: ${constructs.map(c => c.name).join(', ')}.` : ''}`;

    let content = `# File: ${fileInfo.name}\n\n`;
    content += `> **Level:** file | **Path:** \`${relPath}\` | **Language:** ${ext.slice(1) || 'unknown'}\n\n`;
    content += summary + '\n\n';
    if (childEntries.length > 0) {
      content += buildTraverseSection(childEntries);
    }
    content += buildReturnSection(parentId, nextSibling, 'file', fileInfo.name);

    // Append source code so the resolver can read actual code when drilling in
    if (fileContent && CODE_EXTS.has(ext)) {
      content += `\n## Source\n\n\`\`\`${ext.slice(1)}\n${fileContent.slice(0, 8000)}\n\`\`\`\n`;
    }

    notes.push({
      id, title: fileInfo.name, content,
      tags: ['map', 'file'],
      properties: { type: 'map-node', level: 'file', path: relPath, language: ext.slice(1), status: 'pending', children_count: constructs.length },
      _sourceCode: fileContent.slice(0, 6000),
    });

    // Build construct nodes
    const constructIds = childEntries.map(e => e.id);
    for (let i = 0; i < constructs.length; i++) {
      buildConstruct(constructs[i], relPath, id, constructIds, i);
    }
  }

  function buildConstruct(construct, fileRel, parentId, siblingIds, myIdx) {
    const id = nodeId(prefix, fileRel, construct.name);
    const nextSibling = siblingIds && myIdx < siblingIds.length - 1 ? siblingIds[myIdx + 1] : null;

    // Methods as children
    const childEntries = [];
    if (construct.methods?.length) {
      for (const m of construct.methods) {
        const mId = nodeId(prefix, fileRel, construct.name, m.name);
        childEntries.push({ id: mId, label: `method \`${m.name}\`` });
      }
    }

    let summary = `${construct.type} \`${construct.name}\``;
    if (construct.extends) summary += ` extends \`${construct.extends}\``;
    if (construct.line) summary += ` — line ${construct.line}`;
    if (construct.methods?.length) summary += ` — ${construct.methods.length} methods`;

    let content = `# ${construct.type}: ${construct.name}\n\n`;
    content += `> **Level:** ${construct.type} | **File:** \`${fileRel}\`\n\n`;
    content += summary + '\n\n';
    if (childEntries.length > 0) {
      content += buildTraverseSection(childEntries);
    }
    content += buildReturnSection(parentId, nextSibling, construct.type, construct.name);

    notes.push({
      id, title: construct.name, content,
      tags: ['map', construct.type],
      properties: { type: 'map-node', level: construct.type, path: fileRel, status: 'pending', children_count: childEntries.length },
    });

    // Method nodes (leaf level)
    if (construct.methods?.length) {
      const methodIds = childEntries.map(e => e.id);
      for (let i = 0; i < construct.methods.length; i++) {
        const m = construct.methods[i];
        const mId = nodeId(prefix, fileRel, construct.name, m.name);
        const mNext = i < methodIds.length - 1 ? methodIds[i + 1] : null;

        let mContent = `# Method: ${construct.name}.${m.name}\n\n`;
        mContent += `> **Level:** method | **Class:** \`${construct.name}\` | **File:** \`${fileRel}\`\n\n`;
        mContent += `Method \`${m.name}\` of ${construct.type} \`${construct.name}\`.\n\n`;
        mContent += buildReturnSection(id, mNext, 'method', `${construct.name}.${m.name}`);

        notes.push({
          id: mId, title: `${construct.name}.${m.name}`, content: mContent,
          tags: ['map', 'method'],
          properties: { type: 'map-node', level: 'method', path: fileRel, parent_construct: construct.name, status: 'pending' },
        });
      }
    }
  }

  // ── Execute ────────────────────────────────────────────

  buildDir(projectName, '', tree, null, [], 0);

  // Clean up old map nodes with this prefix that won't be overwritten
  const newIds = new Set(notes.map(n => n.id));
  const oldMapNotes = await kb.findByTag('map');
  for (const old of oldMapNotes) {
    if (old.id.startsWith(prefix + '-') && !newIds.has(old.id)) {
      await kb.deleteNote(old.id);
    }
  }

  // Save all notes (saveNote overwrites existing — no duplicates)
  let linkCount = 0;
  for (const note of notes) {
    await kb.saveNote(note);
  }
  for (const note of notes) {
    const { forward } = await kb.getLinks(note.id);
    linkCount += forward.length;
  }

  const constructCount = notes.filter(n => ['class', 'interface', 'function', 'type', 'method'].includes(n.properties?.level)).length;

  // ── LLM summaries ──────────────────────────────────────
  // Parallel batches with retry on rate limit.

  const codeSummarizer = opts.summarize !== false ? createCodeSummarizer() : null;
  let summarized = 0;
  let failed = 0;

  if (codeSummarizer) {
    const onProgress = opts.onProgress || (() => {});
    const BATCH = 10;

    const sourceMap = new Map();
    for (const note of notes) {
      sourceMap.set(note.id, note._sourceCode || note.content);
    }

    async function summarizeOne(note) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const llm = await codeSummarizer({
            level: note.properties?.level || 'code',
            title: note.title,
            filePath: note.properties?.path || '',
            content: sourceMap.get(note.id) || note.content,
          });
          const existing = await kb.engine.getNote(note.id);
          if (existing) {
            await kb.engine.notes.put(note.id, {
              ...existing,
              summary: { ...existing.summary, body: llm.body, intent: llm.intent, keywords: llm.keywords, llm: true },
            });
          }
          return true;
        } catch (e) {
          if (attempt < 2) {
            const wait = e.message?.includes('429') || e.message?.includes('rate') ? (attempt + 1) * 3000 : 500;
            await new Promise(r => setTimeout(r, wait));
          }
        }
      }
      return false;
    }

    for (let i = 0; i < notes.length; i += BATCH) {
      const batch = notes.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(summarizeOne));
      for (const ok of results) { if (ok) summarized++; else failed++; }
      onProgress(summarized, notes.length, failed);
    }
  }

  // ── Vector index ────────────────────────────────────────
  // Build TF-IDF vectors for semantic search

  let indexed = 0;
  if (opts.summarize !== false) {
    const vecIndex = new VectorIndex(kb.engine);
    const vecResult = await vecIndex.buildIndex();
    indexed = vecResult.indexed;
  }

  return {
    root: notes[0]?.id,
    notes: notes.length,
    links: linkCount,
    constructs: constructCount,
    summarized,
    indexed,
  };
}
