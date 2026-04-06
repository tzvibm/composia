#!/usr/bin/env node

/**
 * Composia Session Hooks for Claude Code
 *
 * Three modes:
 *   pre   — Before Claude makes changes, surface relevant context + rules
 *   post  — After a session, capture what happened
 *   rules — Output all rules for Claude to follow (used in CLAUDE.md or SessionStart)
 *
 * Configure in .claude/settings.json:
 *   "hooks": {
 *     "PreToolCall": [{ "command": "node node_modules/composia/src/hooks.js pre" }],
 *     "Stop": [{ "command": "node node_modules/composia/src/hooks.js post" }]
 *   }
 */

import { createEngine } from './engine.js';
import { Knowledge } from './knowledge.js';
import path from 'path';

const DB_PATH = process.env.COMPOSIA_DB || path.join(process.cwd(), '.composia', 'db');
const mode = process.argv[2]; // 'pre', 'post', or 'rules'

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => data += chunk);
    process.stdin.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch { resolve({}); }
    });
    setTimeout(() => resolve({}), 2000);
  });
}

// ── Pre-tool hook: surface context + rules ──────────────

async function preToolCall() {
  const input = await readStdin();
  const toolName = input.tool_name || '';
  const toolInput = input.tool_input || {};

  if (!['Edit', 'Write', 'Bash'].includes(toolName)) return;

  let engine, kb;
  try {
    engine = await createEngine(DB_PATH);
    kb = new Knowledge(engine);

    const output = [];

    // 1. Search for relevant knowledge
    const searchTerms = [];
    if (toolInput.file_path) {
      searchTerms.push(path.basename(toolInput.file_path, path.extname(toolInput.file_path)));
    }
    if (toolInput.command) {
      searchTerms.push(...toolInput.command.split(/\s+/).filter(w => w.length > 3 && !w.startsWith('-')).slice(0, 3));
    }

    if (searchTerms.length > 0) {
      const results = [];
      for (const term of searchTerms) {
        results.push(...await kb.search(term));
      }
      const seen = new Set();
      const unique = results.filter(n => {
        if (seen.has(n.id) || n.id.startsWith('composia-rules')) return false;
        seen.add(n.id);
        return true;
      }).slice(0, 5);

      if (unique.length > 0) {
        output.push('Relevant knowledge:');
        for (const n of unique) {
          output.push(`  - ${n.title}: ${n.content?.slice(0, 120)}...`);
        }
      }
    }

    // 2. Check if any rules apply to this file/context
    const rules = await getRulesForContext(kb, toolInput);
    if (rules.length > 0) {
      output.push('Active rules:');
      for (const rule of rules) {
        output.push(`  - ${rule}`);
      }
    }

    if (output.length > 0) {
      process.stderr.write(`\n[Composia]\n${output.join('\n')}\n`);
    }

    await engine.close();
  } catch (err) {
    if (engine) await engine.close().catch(() => {});
  }
}

async function getRulesForContext(kb, toolInput) {
  const allRules = await loadRules(kb);
  if (allRules.length === 0) return [];

  // Filter rules relevant to this context
  const filePath = toolInput.file_path || toolInput.command || '';
  const relevant = [];

  for (const rule of allRules) {
    // Check if rule has a "when" condition that matches
    const lower = rule.toLowerCase();
    if (lower.includes('always') || lower.includes('every')) {
      relevant.push(rule);
    } else if (filePath && matchesRuleContext(lower, filePath.toLowerCase())) {
      relevant.push(rule);
    }
  }

  return relevant;
}

function matchesRuleContext(ruleLower, contextLower) {
  // Extract keywords from the rule's "when" clause
  const keywords = ['auth', 'security', 'api', 'database', 'db', 'test', 'config',
    'deploy', 'migration', 'schema', 'route', 'model', 'controller', 'service'];
  for (const kw of keywords) {
    if (ruleLower.includes(kw) && contextLower.includes(kw)) return true;
  }
  return false;
}

// ── Load rules from the graph ───────────────────────────

async function loadRules(kb) {
  const rules = [];

  // Load from notes tagged with #rule or #rules
  for (const tag of ['rule', 'rules']) {
    const notes = await kb.findByTag(tag);
    for (const note of notes) {
      const parsed = parseRulesFromContent(note.content);
      rules.push(...parsed);
    }
  }

  // Load the special composia-rules note if it exists
  try {
    const rulesNote = await kb.getNote('composia-rules');
    rules.push(...parseRulesFromContent(rulesNote.content));
  } catch {}

  return [...new Set(rules)]; // deduplicate
}

function parseRulesFromContent(content) {
  if (!content) return [];
  const rules = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    // Extract rules from bullet points and numbered lists
    const match = trimmed.match(/^[-*•]\s+(.+)$/) || trimmed.match(/^\d+\.\s+(.+)$/);
    if (match) {
      const rule = match[1].trim();
      // Skip headings, empty rules, and metadata
      if (rule.length > 10 && !rule.startsWith('#') && !rule.startsWith('**')) {
        rules.push(rule);
      }
    }
  }
  return rules;
}

// ── Post-session hook: capture what happened ────────────

async function postSession() {
  const input = await readStdin();

  const sessionId = `session-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}`;
  const timestamp = new Date().toISOString();
  const transcript = input.transcript || input.messages || [];

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

  let taskDescription = 'Session activity';
  for (let i = transcript.length - 1; i >= 0; i--) {
    if (transcript[i].role === 'user') {
      const content = transcript[i].content;
      taskDescription = typeof content === 'string' ? content : content?.[0]?.text || taskDescription;
      break;
    }
  }

  const fileLinks = [...filesModified].map(f => `[[file-${path.basename(f, path.extname(f))}]]`).join(', ');

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

    // Save session note
    await kb.saveNote({
      id: sessionId,
      title: `Session: ${taskDescription.slice(0, 60)}`,
      content,
      tags: ['session', 'auto-captured'],
    });

    // Also save a context snapshot automatically
    await kb.saveContextSnapshot(`session-${sessionId}`);

    process.stderr.write(`[Composia] Session captured: ${sessionId}\n`);
    await engine.close();
  } catch (err) {
    if (engine) await engine.close().catch(() => {});
  }
}

// ── Rules output (for CLAUDE.md or SessionStart hook) ───

async function outputRules() {
  let engine;
  try {
    engine = await createEngine(DB_PATH);
    const kb = new Knowledge(engine);
    const rules = await loadRules(kb);

    if (rules.length === 0) {
      console.log('No rules configured. Add rules with: composia rules add "your rule here"');
    } else {
      console.log('# Composia Rules\n');
      console.log('Follow these rules when working in this project:\n');
      for (const rule of rules) {
        console.log(`- ${rule}`);
      }
    }

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
} else if (mode === 'rules') {
  await outputRules();
} else {
  console.error('Usage: node hooks.js <pre|post|rules>');
  process.exit(1);
}
