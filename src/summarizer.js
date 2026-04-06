/**
 * Composia Summarizer — LLM-generated summaries for notes.
 *
 * Generates concise, structured summaries using an LLM API.
 * Runs async after save — the deterministic summary is the immediate fallback.
 *
 * Supports:
 *   - Anthropic (Claude) via @anthropic-ai/sdk
 *   - OpenAI-compatible APIs via COMPOSIA_LLM_BASE_URL
 *   - Custom summarizer functions
 *
 * Configuration via environment:
 *   ANTHROPIC_API_KEY    — Use Claude for summaries
 *   OPENAI_API_KEY       — Use OpenAI for summaries
 *   COMPOSIA_LLM_MODEL   — Model to use (default: claude-haiku-4-5-20251001)
 *   COMPOSIA_LLM_BASE_URL — Custom OpenAI-compatible endpoint
 *   COMPOSIA_SUMMARIZE=off — Disable LLM summaries entirely
 */

const SUMMARY_PROMPT = `Summarize this note for a knowledge graph index. Be concise and precise.

Return a JSON object with:
- "body": 1-2 sentence summary of what this note is about and why it matters (max 200 chars)
- "intent": what category this is: "decision", "bug", "pattern", "architecture", "reference", "session", "rule", or "general"
- "keywords": 3-5 key terms not already captured by the title or links

Note title: {{title}}
Note content:
{{content}}

Respond with ONLY the JSON object, no markdown fences.`;

/**
 * Create a summarizer function based on available API keys.
 * Returns null if no API is configured.
 */
export function createSummarizer() {
  if (process.env.COMPOSIA_SUMMARIZE === 'off') return null;

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const baseUrl = process.env.COMPOSIA_LLM_BASE_URL;
  const model = process.env.COMPOSIA_LLM_MODEL || 'claude-haiku-4-5-20251001';

  if (anthropicKey) {
    return createAnthropicSummarizer(anthropicKey, model);
  }
  if (openaiKey || baseUrl) {
    return createOpenAISummarizer(openaiKey, baseUrl, model);
  }
  return null;
}

function createAnthropicSummarizer(apiKey, model) {
  return async function summarize(title, content) {
    const prompt = SUMMARY_PROMPT
      .replace('{{title}}', title)
      .replace('{{content}}', (content || '').slice(0, 4000));

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      throw new Error(`Anthropic API error: ${res.status}`);
    }

    const data = await res.json();
    const text = data.content?.[0]?.text || '';
    return parseSummaryResponse(text);
  };
}

function createOpenAISummarizer(apiKey, baseUrl, model) {
  const url = (baseUrl || 'https://api.openai.com') + '/v1/chat/completions';

  return async function summarize(title, content) {
    const prompt = SUMMARY_PROMPT
      .replace('{{title}}', title)
      .replace('{{content}}', (content || '').slice(0, 4000));

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      throw new Error(`OpenAI API error: ${res.status}`);
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';
    return parseSummaryResponse(text);
  };
}

function parseSummaryResponse(text) {
  try {
    // Strip markdown fences if present
    const clean = text.replace(/```json\s*\n?/g, '').replace(/```\s*$/g, '').trim();
    const parsed = JSON.parse(clean);
    return {
      body: String(parsed.body || '').slice(0, 300),
      intent: parsed.intent || 'general',
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords.slice(0, 10) : [],
    };
  } catch {
    // If JSON parsing fails, use the raw text as body
    return {
      body: text.slice(0, 300),
      intent: 'general',
      keywords: [],
    };
  }
}

/**
 * Enhance a note's summary with LLM-generated content.
 * Merges LLM summary INTO the existing deterministic summary.
 * The deterministic fields (links, sections, hash) are preserved.
 */
export async function enhanceSummary(engine, noteId, summarizer) {
  const note = await engine.getNote(noteId);
  if (!note) return null;

  const llmSummary = await summarizer(note.title, note.content);

  // Merge: LLM body replaces deterministic body, everything else preserved
  const enhanced = {
    ...note.summary,
    body: llmSummary.body,
    intent: llmSummary.intent,
    keywords: llmSummary.keywords,
    llm: true, // flag that this summary was LLM-enhanced
  };

  // Update the note with enhanced summary (without triggering full save cycle)
  await engine.notes.put(noteId, { ...note, summary: enhanced });
  return enhanced;
}

/**
 * Batch-enhance summaries for all notes missing LLM summaries.
 * Respects rate limits with configurable concurrency and delay.
 */
export async function enhanceAll(engine, summarizer, { concurrency = 3, delayMs = 200, onProgress } = {}) {
  const notes = [];
  for await (const [, note] of engine.notes.iterator()) {
    if (!note.summary?.llm) {
      notes.push(note);
    }
  }

  let done = 0;
  let failed = 0;

  for (let i = 0; i < notes.length; i += concurrency) {
    const batch = notes.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map(note => enhanceSummary(engine, note.id, summarizer))
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) done++;
      else failed++;
    }

    if (onProgress) onProgress(done, notes.length, failed);
    if (i + concurrency < notes.length) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  return { enhanced: done, failed, total: notes.length };
}
