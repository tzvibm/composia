/**
 * Composia Resolver — LLM-powered query resolution.
 *
 * Takes a natural language query and resolves it against the knowledge graph
 * using multi-step reasoning:
 *
 * 1. Parse intent: what is the user asking for?
 * 2. Generate search strategies: keywords, tags, properties, linked nodes
 * 3. Execute strategies against the graph
 * 4. Rank and synthesize results
 *
 * This replaces dumb substring search with agent-level reasoning.
 */

const RESOLVE_PROMPT = `You are a knowledge graph query resolver. Given a natural language query and a knowledge graph, determine how to find the relevant information.

The graph supports these operations:
- search(keyword) — full text search
- queryByProperty(field, value) — exact property match
- findByTag(tag) — find notes with a tag
- getLinks(noteId) — get forward links and backlinks for a note
- getGraph(noteId, depth) — traverse neighborhood around a note
- getHistory(noteId) — version history of a note
- getRecentChanges(since) — changes since a timestamp

Given the query below, return a JSON object with:
{
  "strategies": [
    { "op": "search", "args": { "keyword": "..." } },
    { "op": "queryByProperty", "args": { "field": "...", "value": "..." } },
    { "op": "findByTag", "args": { "tag": "..." } },
    { "op": "getLinks", "args": { "noteId": "..." } },
    { "op": "getGraph", "args": { "noteId": "...", "depth": 2 } },
    { "op": "getRecentChanges", "args": { "since": "2026-04-01" } }
  ],
  "reasoning": "brief explanation of your strategy"
}

Generate 2-5 strategies that together would answer the query. Be creative — combine keyword search with graph traversal and property queries.

Available notes (summaries):
{{context}}

Query: {{query}}

Respond with ONLY the JSON object.`;

const SYNTHESIZE_PROMPT = `You found the following notes from the knowledge graph in response to this query:

Query: {{query}}

Results:
{{results}}

Synthesize a clear, concise answer. Reference specific notes by their ID using [[note-id]] format. If the results don't fully answer the query, say what's missing.`;

export class Resolver {
  constructor(knowledge, llmCall) {
    this.kb = knowledge;
    this.llm = llmCall; // async (prompt) => string
  }

  /**
   * Resolve a natural language query against the knowledge graph.
   * Returns { answer, notes, strategies }
   */
  async resolve(query) {
    // Step 1: Get graph context for the LLM (summaries of recent/relevant notes)
    const context = await this._buildContext(query);

    // Step 2: Ask LLM to generate query strategies
    const strategiesPrompt = RESOLVE_PROMPT
      .replace('{{context}}', context)
      .replace('{{query}}', query);

    const strategiesRaw = await this.llm(strategiesPrompt);
    let parsed;
    try {
      const clean = strategiesRaw.replace(/```json\s*\n?/g, '').replace(/```\s*$/g, '').trim();
      parsed = JSON.parse(clean);
    } catch {
      // Fallback: just do a keyword search
      parsed = { strategies: [{ op: 'search', args: { keyword: query } }], reasoning: 'Fallback to keyword search' };
    }

    // Step 3: Execute each strategy
    const allNotes = new Map(); // deduplicate by id
    for (const strategy of parsed.strategies) {
      const notes = await this._executeStrategy(strategy);
      for (const note of notes) {
        if (!allNotes.has(note.id)) {
          allNotes.set(note.id, note);
        }
      }
    }

    const resultNotes = [...allNotes.values()].slice(0, 20);

    // Step 4: Ask LLM to synthesize an answer
    const resultsText = resultNotes.map(n => {
      const summary = typeof n.summary === 'object' ? n.summary.body : n.summary;
      const links = typeof n.summary === 'object' ? n.summary.links?.join(', ') : '';
      return `[[${n.id}]] "${n.title}" — ${summary}${links ? ` (links: ${links})` : ''}`;
    }).join('\n');

    const synthesizePrompt = SYNTHESIZE_PROMPT
      .replace('{{query}}', query)
      .replace('{{results}}', resultsText || 'No results found.');

    const answer = await this.llm(synthesizePrompt);

    return {
      answer,
      notes: resultNotes.map(n => ({ id: n.id, title: n.title, summary: n.summary })),
      strategies: parsed.strategies,
      reasoning: parsed.reasoning,
    };
  }

  async _buildContext(query) {
    // Get a mix of recent notes and keyword-matched notes for context
    const recent = await this.kb.listNotes({ limit: 20 });
    const searched = await this.kb.search(query);
    const all = new Map();
    for (const n of [...searched.slice(0, 10), ...recent]) {
      if (!all.has(n.id)) all.set(n.id, n);
    }

    return [...all.values()].slice(0, 30).map(n => {
      const summary = typeof n.summary === 'object' ? n.summary.body : (n.summary || '');
      return `- [[${n.id}]] "${n.title}" [${(n.tags || []).join(', ')}] — ${summary}`;
    }).join('\n');
  }

  async _executeStrategy(strategy) {
    try {
      switch (strategy.op) {
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
          const changes = await this.kb.getRecentChanges({ since: strategy.args.since, limit: 20 });
          return changes;
        }

        default:
          return [];
      }
    } catch {
      return [];
    }
  }
}

/**
 * Create a resolver with Anthropic or OpenAI backend.
 */
export function createResolver(knowledge) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const baseUrl = process.env.COMPOSIA_LLM_BASE_URL;
  const model = process.env.COMPOSIA_LLM_MODEL || 'claude-haiku-4-5-20251001';

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

  return new Resolver(knowledge, llmCall);
}
