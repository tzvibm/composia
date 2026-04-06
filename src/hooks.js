#!/usr/bin/env node

/**
 * Composia Session Hooks for Claude Code
 *
 * Two hooks:
 *   PreToolCall  — Before Claude makes changes, search the graph for relevant context
 *   PostSession  — After a session, capture what happened as a knowledge graph entry
 *
 * Configure in .claude/settings.json:
 *   "hooks": {
 *     "PreToolCall": [{ "command": "node node_modules/composia/src/hooks.js pre" }],
 *     "PostSession": [{ "command": "node node_modules/composia/src/hooks.js post" }]
 *   }
 *
 * Or for a project using composia locally:
 *   "hooks": {
 *     "PreToolCall": [{ "command": "node src/hooks.js pre" }],
 *     "Stop": [{ "command": "node src/hooks.js post" }]
 *   }
 */

import { createEngine } from './engine.js';
import { Knowledge } from './knowledge.js';
import path from 'path';

const DB_PATH = process.env.COMPOSIA_DB || path.join(process.cwd(), '.composia', 'db');
const mode = process.argv[2]; // 'pre' or 'post'

// Read hook input from stdin
function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => data += chunk);
    process.stdin.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch { resolve({}); }
    });
    // Timeout after 2s in case no stdin
    setTimeout(() => resolve({}), 2000);
  });
}

async function preToolCall() {
  const input = await readStdin();
  const toolName = input.tool_name || '';
  const toolInput = input.tool_input || {};

  // Only trigger on file-modifying tools
  if (!['Edit', 'Write', 'Bash'].includes(toolName)) return;

  let engine, kb;
  try {
    engine = await createEngine(DB_PATH);
    kb = new Knowledge(engine);

    // Extract keywords from the tool input to search the graph
    const searchTerms = [];
    if (toolInput.file_path) {
      const filename = path.basename(toolInput.file_path, path.extname(toolInput.file_path));
      searchTerms.push(filename);
    }
    if (toolInput.command) {
      // Extract meaningful words from bash commands
      const words = toolInput.command.split(/\s+/).filter(w => w.length > 3 && !w.startsWith('-'));
      searchTerms.push(...words.slice(0, 3));
    }

    if (searchTerms.length === 0) return;

    // Search the graph for relevant context
    const results = [];
    for (const term of searchTerms) {
      const found = await kb.search(term);
      results.push(...found);
    }

    // Deduplicate
    const seen = new Set();
    const unique = results.filter(n => {
      if (seen.has(n.id)) return false;
      seen.add(n.id);
      return true;
    }).slice(0, 5);

    if (unique.length > 0) {
      // Output context as a message for Claude to see
      const context = unique.map(n =>
        `- **${n.title}** (${n.tags?.join(', ') || 'no tags'}): ${n.content?.slice(0, 150)}...`
      ).join('\n');

      process.stderr.write(
        `\n[Composia] Relevant knowledge found:\n${context}\n`
      );
    }

    await engine.close();
  } catch (err) {
    // Hooks should never block — fail silently
    if (engine) await engine.close().catch(() => {});
  }
}

async function postSession() {
  const input = await readStdin();

  // Build a session summary note
  const sessionId = `session-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}`;
  const timestamp = new Date().toISOString();

  // Extract info from the stop hook input
  const transcript = input.transcript || input.messages || [];
  const stopReason = input.stop_reason || 'unknown';

  // Collect file paths that were modified
  const filesModified = new Set();
  const toolsUsed = new Set();

  for (const msg of transcript) {
    if (msg.role !== 'assistant') continue;
    const content = Array.isArray(msg.content) ? msg.content : [msg.content];
    for (const block of content) {
      if (block.type === 'tool_use') {
        toolsUsed.add(block.name);
        if (block.input?.file_path) filesModified.add(block.input.file_path);
        if (block.input?.path) filesModified.add(block.input.path);
      }
    }
  }

  // Get the last user message as the task description
  let taskDescription = 'Session activity';
  for (let i = transcript.length - 1; i >= 0; i--) {
    if (transcript[i].role === 'user') {
      const content = transcript[i].content;
      taskDescription = typeof content === 'string' ? content : content?.[0]?.text || taskDescription;
      break;
    }
  }

  const fileLinks = [...filesModified].map(f => {
    const name = path.basename(f, path.extname(f));
    return `[[file-${name}]]`;
  }).join(', ');

  const content = [
    `# Session: ${taskDescription.slice(0, 80)}`,
    '',
    `**Date:** ${timestamp}`,
    `**Tools used:** ${[...toolsUsed].join(', ') || 'none'}`,
    `**Files modified:** ${fileLinks || 'none'}`,
    '',
    `## Task`,
    taskDescription.slice(0, 500),
    '',
    '#session #auto-captured',
  ].join('\n');

  let engine;
  try {
    engine = await createEngine(DB_PATH);
    const kb = new Knowledge(engine);
    await kb.saveNote({
      id: sessionId,
      title: `Session: ${taskDescription.slice(0, 60)}`,
      content,
      tags: ['session', 'auto-captured'],
    });
    process.stderr.write(`[Composia] Session captured: ${sessionId}\n`);
    await engine.close();
  } catch (err) {
    if (engine) await engine.close().catch(() => {});
  }
}

// ── Run ─────────────────────────────────────────────────

if (mode === 'pre') {
  await preToolCall();
} else if (mode === 'post') {
  await postSession();
} else {
  console.error('Usage: node hooks.js <pre|post>');
  process.exit(1);
}
