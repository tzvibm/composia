/**
 * Composia Summarizer — LLM-generated summaries for notes.
 *
 * Configuration priority:
 *   1. .composia/config.json (api_key field)
 *   2. ANTHROPIC_API_KEY environment variable
 *   3. OPENAI_API_KEY environment variable
 *
 * Config file settings:
 *   api_key              — Anthropic API key
 *   llm_model            — Model (default: claude-haiku-4-5-20251001)
 *   llm_base_url         — Custom OpenAI-compatible endpoint
 *   openai_api_key       — OpenAI API key (fallback)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';

// ── Config ──────────────────────────────────────────────

export function loadConfig(cwd = process.cwd()) {
  const configPath = path.join(cwd, '.composia', 'config.json');
  if (existsSync(configPath)) {
    try { return JSON.parse(readFileSync(configPath, 'utf-8')); } catch { return {}; }
  }
  return {};
}

export function saveConfig(updates, cwd = process.cwd()) {
  const dir = path.join(cwd, '.composia');
  mkdirSync(dir, { recursive: true });
  const configPath = path.join(dir, 'config.json');
  const existing = loadConfig(cwd);
  const merged = { ...existing, ...updates };
  writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n');
  return merged;
}

// ── Prompts ─────────────────────────────────────────────

const SUMMARY_PROMPT = `Summarize this note for a knowledge graph index. Be concise and precise.

Return a JSON object with:
- "body": 1-2 sentence summary of what this note is about and why it matters (max 200 chars)
- "intent": what category this is: "decision", "bug", "pattern", "architecture", "reference", "session", "rule", or "general"
- "keywords": 3-5 key terms not already captured by the title or links

Note title: {{title}}
Note content:
{{content}}

Respond with ONLY the JSON object, no markdown fences.`;

const CODE_SUMMARY_PROMPT = `You are summarizing source code for a knowledge graph that AI agents traverse.
Your summary lets agents decide whether to read the full content or skip this node.
Be specific about behavior and purpose, not structure.

Return a JSON object with:
- "body": 1-2 sentence summary of what this code DOES and WHY it matters. Max 200 chars.
- "intent": one of "architecture", "pattern", "utility", "api", "data", "config", "test", "general"
- "keywords": 3-5 domain terms an agent would search for

{{level}}: {{title}}
Path: {{path}}
{{content}}

Respond with ONLY the JSON object, no markdown fences.`;

// ── Summarizer factory ──────────────────────────────────

/**
 * Create a summarizer function. Checks config file first, then env vars.
 * Returns null if no API key is available.
 */
export function createSummarizer() {
  if (process.env.COMPOSIA_SUMMARIZE === 'off') return null;

  const config = loadConfig();
  const anthropicKey = config.api_key || process.env.ANTHROPIC_API_KEY;
  const openaiKey = config.openai_api_key || process.env.OPENAI_API_KEY;
  const baseUrl = config.llm_base_url || process.env.COMPOSIA_LLM_BASE_URL;
  const model = config.llm_model || process.env.COMPOSIA_LLM_MODEL || 'claude-haiku-4-5-20251001';

  if (anthropicKey) return createAnthropicSummarizer(anthropicKey, model);
  if (openaiKey || baseUrl) return createOpenAISummarizer(openaiKey, baseUrl, model);
  return null;
}

/**
 * Create a code-aware summarizer for the mapper.
 * Uses CODE_SUMMARY_PROMPT and accepts { level, title, path, content }.
 */
export function createCodeSummarizer() {
  const config = loadConfig();
  const anthropicKey = config.api_key || process.env.ANTHROPIC_API_KEY;
  const openaiKey = config.openai_api_key || process.env.OPENAI_API_KEY;
  const baseUrl = config.llm_base_url || process.env.COMPOSIA_LLM_BASE_URL;
  const model = config.llm_model || process.env.COMPOSIA_LLM_MODEL || 'claude-haiku-4-5-20251001';

  if (!anthropicKey && !openaiKey && !baseUrl) return null;

  const callLLM = anthropicKey
    ? makeAnthropicCaller(anthropicKey, model)
    : makeOpenAICaller(openaiKey, baseUrl, model);

  return async function summarizeCode({ level, title, filePath, content }) {
    const prompt = CODE_SUMMARY_PROMPT
      .replace('{{level}}', level || 'code')
      .replace('{{title}}', title || '')
      .replace('{{path}}', filePath || '')
      .replace('{{content}}', (content || '').slice(0, 6000));

    const text = await callLLM(prompt);
    return parseSummaryResponse(text);
  };
}

// ── LLM callers ─────────────────────────────────────────

function makeAnthropicCaller(apiKey, model) {
  return async function call(prompt) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model, max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
    const data = await res.json();
    return data.content?.[0]?.text || '';
  };
}

function makeOpenAICaller(apiKey, baseUrl, model) {
  const url = (baseUrl || 'https://api.openai.com') + '/v1/chat/completions';
  return async function call(prompt) {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const res = await fetch(url, {
      method: 'POST', headers,
      body: JSON.stringify({ model, max_tokens: 256, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) throw new Error(`OpenAI API error: ${res.status}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  };
}

// ── Note summarizer (existing interface) ────────────────

function createAnthropicSummarizer(apiKey, model) {
  const call = makeAnthropicCaller(apiKey, model);
  return async function summarize(title, content) {
    const prompt = SUMMARY_PROMPT
      .replace('{{title}}', title)
      .replace('{{content}}', (content || '').slice(0, 4000));
    return parseSummaryResponse(await call(prompt));
  };
}

function createOpenAISummarizer(apiKey, baseUrl, model) {
  const call = makeOpenAICaller(apiKey, baseUrl, model);
  return async function summarize(title, content) {
    const prompt = SUMMARY_PROMPT
      .replace('{{title}}', title)
      .replace('{{content}}', (content || '').slice(0, 4000));
    return parseSummaryResponse(await call(prompt));
  };
}

// ── Response parsing ────────────────────────────────────

function parseSummaryResponse(text) {
  try {
    const clean = text.replace(/```json\s*\n?/g, '').replace(/```\s*$/g, '').trim();
    const parsed = JSON.parse(clean);
    return {
      body: String(parsed.body || '').slice(0, 300),
      intent: parsed.intent || 'general',
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords.slice(0, 10) : [],
    };
  } catch {
    return { body: text.slice(0, 300), intent: 'general', keywords: [] };
  }
}

// ── Enhance existing notes ──────────────────────────────

export async function enhanceSummary(engine, noteId, summarizer) {
  const note = await engine.getNote(noteId);
  if (!note) return null;

  const llmSummary = await summarizer(note.title, note.content);

  const enhanced = {
    ...note.summary,
    body: llmSummary.body,
    intent: llmSummary.intent,
    keywords: llmSummary.keywords,
    llm: true,
  };

  await engine.notes.put(noteId, { ...note, summary: enhanced });
  return enhanced;
}

export async function enhanceAll(engine, summarizer, { concurrency = 3, delayMs = 200, onProgress } = {}) {
  const notes = [];
  for await (const [, note] of engine.notes.iterator()) {
    if (!note.summary?.llm) notes.push(note);
  }

  let done = 0, failed = 0;

  for (let i = 0; i < notes.length; i += concurrency) {
    const batch = notes.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map(note => enhanceSummary(engine, note.id, summarizer))
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) done++; else failed++;
    }
    if (onProgress) onProgress(done, notes.length, failed);
    if (i + concurrency < notes.length) await new Promise(r => setTimeout(r, delayMs));
  }

  return { enhanced: done, failed, total: notes.length };
}
