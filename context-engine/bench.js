#!/usr/bin/env node

// Benchmark: wiki-context vs chat-history
// Runs the same conversation through both systems and compares

import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { Wiki } from './wiki.js';
import { ContextEngine, ChatBaseline } from './context.js';

const BENCH_WIKI = join(process.cwd(), '.composia', 'bench-wiki');

// Test conversations — multi-turn with questions that require memory of prior turns
const TEST_CONVERSATIONS = [
  {
    name: 'Technical decisions',
    turns: [
      'We chose PostgreSQL over MongoDB because we need ACID transactions for our payment system.',
      'The payment service also uses Stripe webhooks with idempotency keys to prevent double charges.',
      'We added Redis for caching session tokens, with a 15-minute TTL.',
      // Questions that require remembering prior context
      'What database did we choose and why?',
      'How do we prevent double charges?',
      'What is the TTL for session tokens and where are they cached?',
      'Give me a complete summary of our payment system architecture.',
    ]
  },
  {
    name: 'Evolving requirements',
    turns: [
      'Our API uses REST with JSON responses.',
      'Actually, we decided to migrate the real-time endpoints to GraphQL subscriptions.',
      'The REST endpoints will stay for CRUD operations, only real-time moves to GraphQL.',
      'We also added rate limiting: 100 requests per minute for free tier, 1000 for paid.',
      // Questions that test handling of corrections/updates
      'Do we use REST or GraphQL?',
      'What are our rate limits?',
      'Summarize our complete API architecture including what changed.',
    ]
  },
  {
    name: 'Cross-referencing',
    turns: [
      'The auth service uses JWT tokens signed with RS256.',
      'The API gateway validates JWT tokens before routing requests.',
      'The user service stores user profiles and preferences.',
      'The notification service sends emails when auth events occur — login from new device, password change.',
      'When a user logs in, the auth service issues a JWT, the gateway validates it, and the notification service logs the event.',
      // Questions requiring cross-referencing
      'What happens when a user logs in? Trace the full flow.',
      'Which services interact with the auth service?',
      'If I need to change the JWT signing algorithm, which services are affected?',
    ]
  }
];

async function runBenchmark() {
  console.log('=== Composia Context Engine Benchmark ===');
  console.log('Comparing: wiki-as-context vs chat-history\n');

  const results = [];

  for (const conv of TEST_CONVERSATIONS) {
    console.log(`\n--- ${conv.name} ---\n`);

    // Clean wiki for each test
    if (existsSync(BENCH_WIKI)) rmSync(BENCH_WIKI, { recursive: true });
    mkdirSync(join(BENCH_WIKI, 'pages'), { recursive: true });

    // Initialize wiki
    const { readFileSync } = await import('fs');
    const { fileURLToPath } = await import('url');
    const { dirname } = await import('path');
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);

    const schema = readFileSync(join(__dirname, 'schema.md'), 'utf-8');
    const { writeFileSync } = await import('fs');
    writeFileSync(join(BENCH_WIKI, 'schema.md'), schema);
    writeFileSync(join(BENCH_WIKI, 'index.md'), '# Wiki Index\n\n## Pages\n\n_Empty_\n');
    const now = new Date().toISOString().split('T')[0];
    writeFileSync(join(BENCH_WIKI, 'log.md'), `# Wiki Log\n\n## [${now}] init | Benchmark wiki initialized\n`);

    const wiki = new Wiki(BENCH_WIKI);
    const wikiEngine = new ContextEngine(wiki, {
      model: process.env.COMPOSIA_MODEL || 'claude-sonnet-4-20250514',
      builderModel: process.env.COMPOSIA_BUILDER_MODEL || 'claude-haiku-4-5-20251001'
    });
    const chatBaseline = new ChatBaseline({
      model: process.env.COMPOSIA_MODEL || 'claude-sonnet-4-20250514'
    });

    const convResult = { name: conv.name, turns: [] };

    for (let i = 0; i < conv.turns.length; i++) {
      const input = conv.turns[i];
      const isQuestion = input.includes('?');

      console.log(`Turn ${i + 1}: ${input.slice(0, 60)}${input.length > 60 ? '...' : ''}`);

      try {
        // Run both systems
        const [wikiResult, chatResult] = await Promise.all([
          wikiEngine.turn(input),
          chatBaseline.turn(input)
        ]);

        const turnResult = {
          input,
          isQuestion,
          wiki: {
            response: wikiResult.response,
            pages: wikiResult.wikiStats.totalPages
          },
          chat: {
            response: chatResult.response,
            historyLength: chatResult.historyLength
          }
        };

        convResult.turns.push(turnResult);

        if (isQuestion) {
          console.log(`  [WIKI] ${wikiResult.response.slice(0, 100)}...`);
          console.log(`  [CHAT] ${chatResult.response.slice(0, 100)}...`);
          console.log(`  Wiki pages: ${wikiResult.wikiStats.totalPages}`);
        } else {
          console.log(`  Wiki pages: ${wikiResult.wikiStats.totalPages} | Chat history: ${chatResult.historyLength} messages`);
        }
      } catch (err) {
        console.error(`  Error: ${err.message}`);
      }
    }

    results.push(convResult);
  }

  // Summary
  console.log('\n\n=== RESULTS ===\n');
  for (const conv of results) {
    console.log(`${conv.name}:`);
    const questions = conv.turns.filter(t => t.isQuestion);
    for (const q of questions) {
      console.log(`\n  Q: ${q.input}`);
      console.log(`  [WIKI]: ${q.wiki.response.slice(0, 200)}`);
      console.log(`  [CHAT]: ${q.chat.response.slice(0, 200)}`);
    }
  }

  // Cleanup
  if (existsSync(BENCH_WIKI)) rmSync(BENCH_WIKI, { recursive: true });

  console.log('\n\nDone. Review the responses above to compare quality.');
  console.log('The wiki system should maintain structured knowledge across turns.');
  console.log('The chat system relies on raw history — watch for degradation over longer conversations.');
}

runBenchmark().catch(console.error);
