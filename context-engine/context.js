// Context builder: uses an LLM to update the wiki, then builds context for the reasoning LLM

import Anthropic from '@anthropic-ai/sdk';

const UPDATE_SYSTEM = `You are a wiki maintenance agent. Your job is to update a knowledge wiki based on new input.

You will receive:
1. The current wiki state (schema, index, and all pages)
2. New input to process (either a user message or an LLM response)

You must output a JSON object with wiki operations to perform:

{
  "pages": {
    "page-name": "full markdown content for this page (create or overwrite)",
    ...
  },
  "index": "full updated index.md content",
  "log_entry": "short description of what changed"
}

Rules:
- Follow the schema for page format and cross-referencing
- One concept per page
- Every page must have [[cross-references]]
- Update the index to reflect any new or changed pages
- If no updates needed, return {"pages": {}, "index": null, "log_entry": null}
- Return ONLY valid JSON, no markdown fences, no explanation`;

const REASON_SYSTEM = `You are a knowledgeable assistant. Your context is a structured wiki — a knowledge base of interconnected pages built from this conversation.

You do NOT have access to chat history. The wiki IS your memory. Everything you know about this conversation is in the wiki pages provided.

Answer the user's question based on the wiki context. Be specific and reference relevant wiki pages where applicable.

If the wiki doesn't contain enough information to answer fully, say so and answer with what you have.`;

export class ContextEngine {
  constructor(wiki, opts = {}) {
    this.wiki = wiki;
    this.client = new Anthropic();
    this.model = opts.model || 'claude-sonnet-4-20250514';
    this.builderModel = opts.builderModel || 'claude-haiku-4-5-20251001';
  }

  // Update the wiki with new input
  async updateWiki(input, source = 'user') {
    const wikiContext = this.wiki.buildContext();

    const response = await this.client.messages.create({
      model: this.builderModel,
      max_tokens: 4096,
      system: UPDATE_SYSTEM,
      messages: [{
        role: 'user',
        content: `Current wiki state:\n\n${wikiContext}\n\n---\n\nNew ${source} input to process:\n\n${input}`
      }]
    });

    const text = response.content[0].text;
    let ops;
    try {
      ops = JSON.parse(text);
    } catch {
      // Try to extract JSON from response
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        ops = JSON.parse(match[0]);
      } else {
        console.error('Failed to parse wiki update response');
        return { pagesUpdated: 0 };
      }
    }

    let pagesUpdated = 0;

    // Write pages
    if (ops.pages) {
      for (const [name, content] of Object.entries(ops.pages)) {
        if (content) {
          this.wiki.writePage(name, content);
          pagesUpdated++;
        }
      }
    }

    // Update index
    if (ops.index) {
      this.wiki.writeIndex(ops.index);
    }

    // Append log
    if (ops.log_entry) {
      this.wiki.appendLog(`${source} | ${ops.log_entry}`);
    }

    return { pagesUpdated };
  }

  // Get a response from the reasoning LLM using wiki as context
  async reason(userMessage) {
    const wikiContext = this.wiki.buildContext();

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: `${REASON_SYSTEM}\n\n--- WIKI CONTEXT ---\n\n${wikiContext}`,
      messages: [{
        role: 'user',
        content: userMessage
      }]
    });

    return response.content[0].text;
  }

  // Full turn: update wiki with user input → reason → update wiki with response
  async turn(userMessage) {
    // Step 1: Update wiki with user input
    const userUpdate = await this.updateWiki(userMessage, 'user');

    // Step 2: Reason using wiki as context
    const response = await this.reason(userMessage);

    // Step 3: Update wiki with LLM response
    const responseUpdate = await this.updateWiki(response, 'assistant');

    return {
      response,
      wikiStats: {
        pagesAfterUserUpdate: userUpdate.pagesUpdated,
        pagesAfterResponseUpdate: responseUpdate.pagesUpdated,
        totalPages: this.wiki.pageCount()
      }
    };
  }
}

// Standard chat-history baseline for benchmarking
export class ChatBaseline {
  constructor(opts = {}) {
    this.client = new Anthropic();
    this.model = opts.model || 'claude-sonnet-4-20250514';
    this.history = [];
  }

  async turn(userMessage) {
    this.history.push({ role: 'user', content: userMessage });

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      messages: this.history
    });

    const text = response.content[0].text;
    this.history.push({ role: 'assistant', content: text });

    return {
      response: text,
      historyLength: this.history.length
    };
  }
}
