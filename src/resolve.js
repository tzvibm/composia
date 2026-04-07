/**
 * Composia Resolver — LLM-powered query resolution with visible reasoning trace.
 *
 * Shows the developer exactly how it traversed the graph:
 *   1. What strategies it chose and why
 *   2. Which nodes it visited at each step
 *   3. Which nodes it drilled into for more detail
 *   4. How it synthesized the final answer
 */

import { loadConfig } from './summarizer.js';
import { VectorIndex } from './vectors.js';
import { execSync } from 'child_process';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import path from 'path';

const RESOLVE_PROMPT = `You are a knowledge graph query resolver. Given a natural language query and a knowledge graph, determine how to find the relevant information.

The graph supports these operations:

GRAPH OPERATIONS (search the knowledge graph):
- semantic(query) — vector similarity search (finds notes by meaning, not just keywords — USE THIS FIRST)
- search(keyword) — full text keyword search on notes
- queryByProperty(field, value) — exact property match
- findByTag(tag) — find notes with a tag
- getLinks(noteId) — get forward links and backlinks for a note
- getGraph(noteId, depth) — traverse neighborhood around a note
- getHistory(noteId) — version history of a note
- getRecentChanges(since) — changes since a timestamp

FILE SYSTEM OPERATIONS (search actual source code — use these to find specific code, commands, patterns):
- grep(pattern, glob) — search file contents with regex. Returns matching lines with file paths. glob filters files (e.g. "*.js", "src/**/*.ts")
- glob(pattern) — find files by name pattern (e.g. "**/*.test.js", "src/**/index.*")
- readFile(filePath, startLine, endLine) — read a specific file or line range. Use after grep to see surrounding context
- findDefinition(name) — find where a function, class, or variable is defined (searches for "class Name", "function name", "const name =")

Given the query below, return a JSON object with:
{
  "strategies": [
    { "op": "semantic", "args": { "query": "..." } },
    { "op": "search", "args": { "keyword": "..." } },
    { "op": "grep", "args": { "pattern": "regex pattern", "glob": "*.js" } },
    { "op": "glob", "args": { "pattern": "src/**/*.js" } },
    { "op": "readFile", "args": { "filePath": "src/cli.js", "startLine": 1, "endLine": 50 } },
    { "op": "findDefinition", "args": { "name": "createEngine" } },
    { "op": "getGraph", "args": { "noteId": "...", "depth": 2 } },
    { "op": "getLinks", "args": { "noteId": "..." } },
    { "op": "findByTag", "args": { "tag": "..." } },
    { "op": "queryByProperty", "args": { "field": "...", "value": "..." } }
  ],
  "reasoning": "brief explanation of your strategy"
}

Generate 3-6 strategies that COMBINE graph and file system operations:
1. Start with semantic search to find the right area of the graph
2. Use grep/findDefinition to find specific code, commands, or patterns in actual source files
3. Use graph traversal to explore connections between concepts
4. Use readFile when you need to see the actual implementation

The best answers come from combining graph knowledge (summaries, connections) with actual source code (grep, readFile). For "how do I" questions, grep for CLI commands and configuration. For architecture questions, use graph traversal. For debugging, grep for error messages and read the relevant code.

Available notes (summaries):
{{context}}

Query: {{query}}

Respond with ONLY the JSON object.`;

const DRILL_PROMPT = `You are traversing a knowledge graph to answer a query. You've found these nodes so far (summaries only):

{{found}}

Query: {{query}}

Which nodes should be READ IN FULL to answer this query? Pick the 3-5 most relevant nodes whose full content would contain the actual answer (code, commands, config, details).
Return a JSON object:
{
  "read": ["noteId1", "noteId2", "noteId3"],
  "reasoning": "why reading these nodes will answer the query"
}

Respond with ONLY the JSON object.`;

const SYNTHESIZE_PROMPT = `You found the following from the knowledge graph. Some nodes were read in full (you can see their actual code, commands, and content). Others are summaries.

Query: {{query}}

Results:
{{results}}

Give a direct, actionable answer. Include specific CLI commands, code snippets, or config from the full-content sections. Reference notes using [[note-id]] format. Be concrete — if the answer includes a command, show the exact command to run.`;

export class Resolver {
  constructor(knowledge, llmCall, projectRoot) {
    this.kb = knowledge;
    this.llm = llmCall;
    this._projectRoot = projectRoot || process.cwd();
  }

  /**
   * Resolve a query with full reasoning trace visible.
   * Returns { answer, notes, trace }
   */
  async resolve(query, { onTrace } = {}) {
    const trace = [];
    const log = (step) => {
      trace.push(step);
      if (onTrace) onTrace(step);
    };

    // Step 1: Build context from graph (vector + keyword + recent)
    log({ phase: 'context', message: 'Scanning graph for relevant nodes...' });
    const context = await this._buildContext(query);
    log({
      phase: 'context',
      message: `Found ${context.noteCount} candidates: ${context.vecCount} via semantic search, ${context.keywordCount} via keyword, ${context.recentCount} via recent`,
      nodes: context.noteIds,
    });

    // Step 2: Ask LLM to generate strategies
    log({ phase: 'strategy', message: 'Asking LLM to plan query strategies...' });
    const strategiesPrompt = RESOLVE_PROMPT
      .replace('{{context}}', context.text)
      .replace('{{query}}', query);

    const strategiesRaw = await this.llm(strategiesPrompt);
    let parsed;
    try {
      const clean = strategiesRaw.replace(/```json\s*\n?/g, '').replace(/```\s*$/g, '').trim();
      parsed = JSON.parse(clean);
    } catch {
      parsed = { strategies: [{ op: 'search', args: { keyword: query } }], reasoning: 'Fallback to keyword search' };
    }

    log({
      phase: 'strategy',
      message: `LLM reasoning: ${parsed.reasoning}`,
      strategies: parsed.strategies.map(s => `${s.op}(${JSON.stringify(s.args)})`),
    });

    // Step 3: Execute each strategy and collect results
    const allNotes = new Map();
    for (const strategy of parsed.strategies) {
      const opStr = `${strategy.op}(${JSON.stringify(strategy.args)})`;
      log({ phase: 'execute', message: `Executing: ${opStr}` });

      const notes = await this._executeStrategy(strategy);
      const newIds = [];
      for (const note of notes) {
        if (!allNotes.has(note.id)) {
          allNotes.set(note.id, note);
          newIds.push(note.id);
        }
      }

      log({
        phase: 'execute',
        message: `${opStr} → ${notes.length} results (${newIds.length} new)`,
        found: newIds,
      });
    }

    // Step 4: Read — pick the most relevant nodes and read their FULL content
    const resultNotes = [...allNotes.values()].slice(0, 30);
    const readContents = new Map(); // noteId → full content

    if (resultNotes.length > 0) {
      log({ phase: 'read', message: `Selecting which of ${resultNotes.length} nodes to read in full...` });

      const foundText = resultNotes.map(n => {
        const summary = typeof n.summary === 'object' ? n.summary.body : n.summary;
        return `[[${n.id}]] "${n.title}" — ${summary}`;
      }).join('\n');

      const drillPrompt = DRILL_PROMPT
        .replace('{{found}}', foundText)
        .replace('{{query}}', query);

      try {
        const drillRaw = await this.llm(drillPrompt);
        const clean = drillRaw.replace(/```json\s*\n?/g, '').replace(/```\s*$/g, '').trim();
        const drillParsed = JSON.parse(clean);
        const toRead = drillParsed.read || drillParsed.drill || [];

        if (toRead.length > 0) {
          log({
            phase: 'read',
            message: `Reading full content of: ${toRead.join(', ')} — ${drillParsed.reasoning}`,
            drillTargets: toRead,
          });

          for (const noteId of toRead.slice(0, 5)) {
            try {
              const note = await this.kb.engine.getNote(noteId).catch(() => null);
              if (note?.content) {
                readContents.set(noteId, note.content.slice(0, 4000));
                log({ phase: 'read', message: `[[${noteId}]] — read ${note.content.length} chars` });
              }

              // Also follow links to discover connected nodes
              const { forward, backlinks } = await this.kb.getLinks(noteId);
              for (const link of [...forward.map(l => l.target), ...backlinks.map(l => l.source)]) {
                if (!allNotes.has(link)) {
                  const linked = await this.kb.engine.getNote(link).catch(() => null);
                  if (linked) allNotes.set(link, linked);
                }
              }
            } catch { /* node doesn't exist */ }
          }
        } else {
          log({ phase: 'read', message: 'No nodes selected for full read.' });
        }
      } catch {
        log({ phase: 'read', message: 'Skipping read step (LLM parse error).' });
      }
    }

    // Step 5: Synthesize answer with FULL CONTENT of read nodes + summaries of the rest
    const finalNotes = [...allNotes.values()].slice(0, 20);
    log({ phase: 'synthesize', message: `Synthesizing from ${readContents.size} full reads + ${finalNotes.length} summaries...` });

    let resultsText = '';

    // Separate file results from graph notes
    const fileResults = finalNotes.filter(n => n._isFileResult);
    const graphNotes = finalNotes.filter(n => !n._isFileResult);

    // File system results (grep matches, file contents, definitions)
    if (fileResults.length > 0) {
      resultsText += '=== SOURCE CODE (from grep/readFile/findDefinition) ===\n\n';
      for (const r of fileResults) {
        resultsText += `--- ${r.title} ---\n${r.content}\n\n`;
      }
    }

    // Full content of read nodes
    if (readContents.size > 0) {
      resultsText += '=== FULL NOTE CONTENT (read in detail) ===\n\n';
      for (const [id, content] of readContents) {
        const note = allNotes.get(id);
        resultsText += `--- [[${id}]] "${note?.title || id}" ---\n${content}\n\n`;
      }
    }

    // Summaries of remaining graph notes
    if (graphNotes.length > 0) {
      resultsText += '=== GRAPH SUMMARIES ===\n\n';
      for (const n of graphNotes) {
        if (readContents.has(n.id)) continue;
        const summary = typeof n.summary === 'object' ? n.summary.body : n.summary;
        const links = typeof n.summary === 'object' ? n.summary.links?.join(', ') : '';
        resultsText += `[[${n.id}]] "${n.title}" — ${summary}${links ? ` (links: ${links})` : ''}\n`;
      }
    }

    const synthesizePrompt = SYNTHESIZE_PROMPT
      .replace('{{query}}', query)
      .replace('{{results}}', resultsText || 'No results found.');

    const answer = await this.llm(synthesizePrompt);

    log({ phase: 'done', message: 'Answer synthesized.' });

    return {
      answer,
      notes: finalNotes.map(n => ({ id: n.id, title: n.title, summary: n.summary })),
      strategies: parsed.strategies,
      reasoning: parsed.reasoning,
      trace,
    };
  }

  async _buildContext(query) {
    const all = new Map();
    let vecCount = 0, keywordCount = 0, recentCount = 0;

    // 1. Vector search (semantic — best entry points)
    try {
      const vecIndex = new VectorIndex(this.kb.engine);
      const vecResults = await vecIndex.search(query, { limit: 15 });
      for (const r of vecResults) {
        const note = await this.kb.engine.getNote(r.id).catch(() => null);
        if (note) { all.set(note.id, { ...note, _vecScore: r.score }); vecCount++; }
      }
    } catch { /* no vector index built */ }

    // 2. Keyword search (catches exact matches vectors might miss)
    const searched = await this.kb.search(query);
    for (const n of searched.slice(0, 10)) {
      if (!all.has(n.id)) { all.set(n.id, n); keywordCount++; }
    }

    // 3. Recent notes (for temporal context)
    const recent = await this.kb.listNotes({ limit: 10 });
    for (const n of recent) {
      if (!all.has(n.id)) { all.set(n.id, n); recentCount++; }
    }

    const notes = [...all.values()].slice(0, 30);
    const text = notes.map(n => {
      const summary = typeof n.summary === 'object' ? n.summary.body : (n.summary || '');
      const score = n._vecScore ? ` [similarity: ${n._vecScore}]` : '';
      return `- [[${n.id}]] "${n.title}" [${(n.tags || []).join(', ')}]${score} — ${summary}`;
    }).join('\n');

    return { text, noteCount: notes.length, noteIds: notes.map(n => n.id), vecCount, keywordCount, recentCount };
  }

  async _executeStrategy(strategy) {
    try {
      switch (strategy.op) {
        case 'semantic': {
          const vecIndex = new VectorIndex(this.kb.engine);
          const results = await vecIndex.search(strategy.args.query, { limit: 15 });
          const notes = [];
          for (const r of results) {
            const note = await this.kb.engine.getNote(r.id).catch(() => null);
            if (note) notes.push(note);
          }
          return notes;
        }

        case 'search':
          return await this.kb.search(strategy.args.keyword);

        case 'queryByProperty':
          return await this.kb.queryByProperty(strategy.args.field, strategy.args.value);

        case 'findByTag':
          return await this.kb.findByTag(strategy.args.tag);

        case 'getLinks': {
          const { forward, backlinks } = await this.kb.getLinks(strategy.args.noteId);
          const noteIds = [...forward.map(l => l.target), ...backlinks.map(l => l.source)];
          const notes = [];
          for (const id of noteIds) {
            const note = await this.kb.engine.getNote(id).catch(() => null);
            if (note) notes.push(note);
          }
          return notes;
        }

        case 'getGraph': {
          const graph = await this.kb.getGraph(strategy.args.noteId, strategy.args.depth || 2);
          const notes = [];
          for (const node of graph.nodes) {
            const note = await this.kb.engine.getNote(node.id).catch(() => null);
            if (note) notes.push(note);
          }
          return notes;
        }

        case 'getRecentChanges': {
          return await this.kb.getRecentChanges({ since: strategy.args.since, limit: 20 });
        }

        // ── File system operations ──────────────────────

        case 'grep': {
          const { pattern, glob: fileGlob } = strategy.args;
          const results = fileGrep(pattern, fileGlob, this._projectRoot);
          // Return as pseudo-notes so they flow into synthesis
          return results.map(r => ({
            id: `file:${r.file}:${r.line}`,
            title: `${r.file}:${r.line}`,
            content: r.context,
            summary: { body: r.match },
            tags: ['grep-result'],
            _isFileResult: true,
          }));
        }

        case 'glob': {
          const files = fileGlob(strategy.args.pattern, this._projectRoot);
          return files.map(f => ({
            id: `file:${f}`,
            title: f,
            content: '',
            summary: { body: `File: ${f}` },
            tags: ['glob-result'],
            _isFileResult: true,
          }));
        }

        case 'readFile': {
          const { filePath, startLine, endLine } = strategy.args;
          const content = fileRead(filePath, startLine, endLine, this._projectRoot);
          return [{
            id: `file:${filePath}`,
            title: filePath,
            content,
            summary: { body: `Contents of ${filePath}${startLine ? ` (lines ${startLine}-${endLine || 'end'})` : ''}` },
            tags: ['file-content'],
            _isFileResult: true,
          }];
        }

        case 'findDefinition': {
          const { name } = strategy.args;
          const results = fileFindDefinition(name, this._projectRoot);
          return results.map(r => ({
            id: `file:${r.file}:${r.line}`,
            title: `${r.file}:${r.line}`,
            content: r.context,
            summary: { body: `${r.type} ${name} defined at ${r.file}:${r.line}` },
            tags: ['definition'],
            _isFileResult: true,
          }));
        }

        default:
          return [];
      }
    } catch {
      return [];
    }
  }
}

// ── File system helpers ─────────────────────────────────

function fileGrep(pattern, fileGlob, projectRoot) {
  const root = projectRoot || process.cwd();
  try {
    const globArg = fileGlob ? `--glob '${fileGlob}'` : '';
    const cmd = `cd "${root}" && rg -n --max-count 30 -C 1 ${globArg} '${pattern.replace(/'/g, "\\'")}' 2>/dev/null || grep -rn --include='${fileGlob || '*.js'}' '${pattern.replace(/'/g, "\\'")}' . 2>/dev/null | head -50`;
    const output = execSync(cmd, { encoding: 'utf-8', timeout: 5000 }).trim();
    if (!output) return [];

    const results = [];
    for (const line of output.split('\n').slice(0, 30)) {
      const match = line.match(/^([^:]+):(\d+)[:-](.*)$/);
      if (match) {
        results.push({ file: match[1], line: parseInt(match[2]), match: match[3].trim(), context: line });
      }
    }
    return results;
  } catch {
    return [];
  }
}

function fileGlob(pattern, projectRoot) {
  const root = projectRoot || process.cwd();
  try {
    const cmd = `cd "${root}" && find . -path './node_modules' -prune -o -path './.git' -prune -o -path './.composia/db' -prune -o -name '${pattern.replace(/\*\*/g, '*')}' -print 2>/dev/null | head -30`;
    const output = execSync(cmd, { encoding: 'utf-8', timeout: 5000 }).trim();
    return output ? output.split('\n').filter(f => f && !f.includes('node_modules')) : [];
  } catch {
    return [];
  }
}

function fileRead(filePath, startLine, endLine, projectRoot) {
  const root = projectRoot || process.cwd();
  const fullPath = path.resolve(root, filePath);
  if (!existsSync(fullPath)) return `File not found: ${filePath}`;
  try {
    const content = readFileSync(fullPath, 'utf-8');
    if (startLine || endLine) {
      const lines = content.split('\n');
      const start = Math.max(0, (startLine || 1) - 1);
      const end = endLine ? Math.min(lines.length, endLine) : Math.min(lines.length, start + 100);
      return lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join('\n');
    }
    // Cap at 200 lines
    const lines = content.split('\n');
    if (lines.length > 200) {
      return lines.slice(0, 200).map((l, i) => `${i + 1}: ${l}`).join('\n') + `\n... (${lines.length - 200} more lines)`;
    }
    return lines.map((l, i) => `${i + 1}: ${l}`).join('\n');
  } catch (e) {
    return `Error reading ${filePath}: ${e.message}`;
  }
}

function fileFindDefinition(name, projectRoot) {
  const root = projectRoot || process.cwd();
  const patterns = [
    `class\\s+${name}\\b`,
    `function\\s+${name}\\s*\\(`,
    `(const|let|var|export)\\s+${name}\\s*=`,
    `def\\s+${name}\\s*\\(`,
    `type\\s+${name}\\s+struct`,
    `interface\\s+${name}\\b`,
  ];
  const results = [];
  for (const pat of patterns) {
    const found = fileGrep(pat, '*.{js,ts,py,go,rs,java,jsx,tsx}', root);
    results.push(...found.map(r => ({ ...r, type: 'definition' })));
  }
  // Deduplicate by file:line
  const seen = new Set();
  return results.filter(r => {
    const key = `${r.file}:${r.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Create a resolver. Reads API key from config.json first, then env vars.
 */
export function createResolver(knowledge) {
  const config = loadConfig();
  const anthropicKey = config.api_key || process.env.ANTHROPIC_API_KEY;
  const openaiKey = config.openai_api_key || process.env.OPENAI_API_KEY;
  const baseUrl = config.llm_base_url || process.env.COMPOSIA_LLM_BASE_URL;
  const model = config.llm_model || process.env.COMPOSIA_LLM_MODEL || 'claude-haiku-4-5-20251001';

  let llmCall;

  if (anthropicKey) {
    llmCall = async (prompt) => {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ model, max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }),
      });
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const data = await res.json();
      return data.content?.[0]?.text || '';
    };
  } else if (openaiKey || baseUrl) {
    const url = (baseUrl || 'https://api.openai.com') + '/v1/chat/completions';
    llmCall = async (prompt) => {
      const headers = { 'Content-Type': 'application/json' };
      if (openaiKey) headers['Authorization'] = `Bearer ${openaiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }),
      });
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const data = await res.json();
      return data.choices?.[0]?.message?.content || '';
    };
  } else {
    return null;
  }

  return new Resolver(knowledge, llmCall, process.cwd());
}
