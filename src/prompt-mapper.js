/**
 * Prompt Mapper — decomposes a user prompt into a temporary execution graph.
 *
 * This is the "compiler" stage. The user's natural language prompt is analyzed
 * by the LLM, which breaks it into discrete steps. Each step becomes a real
 * node in the graph with:
 *   - Instructions (what the LLM should do at this step)
 *   - ## Traverse links to child steps or relevant existing graph nodes
 *   - ## Return backlink to parent with context template
 *   - Properties: status (pending/running/done), session, confidence
 *
 * The result is a connected execution graph that the runtime can walk.
 */

import { loadConfig } from './summarizer.js';
import { slugify } from './parser.js';

// ── LLM prompt for decomposing user input into an execution graph ──

const DECOMPOSE_PROMPT = `You are a task decomposition engine for a knowledge graph runtime. Given a user prompt and the available knowledge graph context, break the prompt into discrete execution steps.

Each step will become a node in an execution graph. Nodes are connected by links (control flow). The LLM runtime will visit each node sequentially, execute its instructions, and carry results back via return context.

Available knowledge graph nodes (these already exist — you can reference them):
{{context}}

User prompt: {{prompt}}

Return a JSON object with this structure:
{
  "title": "Short title for this execution plan",
  "steps": [
    {
      "id": "step-slug",
      "title": "Step title",
      "instruction": "Detailed instruction for what the LLM should do at this node. Be specific — reference graph nodes by [[id]] where relevant.",
      "references": ["existing-node-id-1", "existing-node-id-2"],
      "dependsOn": [],
      "condition": null
    },
    {
      "id": "step-analyze",
      "title": "Analyze findings",
      "instruction": "Given the return context from the previous steps, analyze...",
      "references": [],
      "dependsOn": ["step-slug"],
      "condition": null
    }
  ]
}

Rules:
- Generate 2-8 steps. Each step should be a meaningful unit of work.
- "references" are IDs of EXISTING graph nodes the step should read/traverse. Use the node IDs from the context above.
- "dependsOn" lists step IDs that must complete before this step runs. This creates the graph structure.
- "condition" is optional: "if <condition> from {{depId}}" — makes this a conditional branch.
- Steps with no dependsOn run first (entry points).
- The LAST step should synthesize all return context into a final answer.
- Instructions should be concrete — tell the LLM exactly what to look for, analyze, or produce.
- Reference existing graph nodes with [[id]] in instructions when relevant.

Respond with ONLY the JSON object.`;

// ── Build the execution graph ──────────────────────────────

/**
 * Build an execution graph from a user prompt.
 *
 * @param {Knowledge} kb - Knowledge instance
 * @param {string} prompt - User's natural language prompt
 * @param {object} opts - { sessionId, maxNodes, llm }
 * @returns {{ rootId, sessionId, nodes[], edges[] }}
 */
export async function buildExecutionGraph(kb, prompt, opts = {}) {
  const sessionId = opts.sessionId || `session-${Date.now()}`;
  const maxNodes = opts.maxNodes || 15;
  const onEvent = opts.onEvent || (() => {});

  // 1. Get LLM function
  const llm = opts.llm || createLLM();
  if (!llm) throw new Error('No API key configured. Run: composia config set api_key <key>');

  // 2. Build context from existing graph
  onEvent({ phase: 'context', message: 'Scanning graph for relevant nodes...' });
  const context = await buildContext(kb, prompt);
  onEvent({ phase: 'context', message: `Found ${context.notes.length} relevant nodes` });

  // 3. Ask LLM to decompose prompt into steps
  onEvent({ phase: 'decompose', message: 'Decomposing prompt into execution steps...' });
  const decomposed = await decompose(llm, prompt, context.text, maxNodes);
  onEvent({
    phase: 'decompose',
    message: `Plan: "${decomposed.title}" — ${decomposed.steps.length} steps`,
    steps: decomposed.steps.map(s => s.title),
  });

  // 4. Create graph nodes
  onEvent({ phase: 'build', message: 'Building execution graph...' });
  const timestamp = Date.now();
  const rootId = `plan-${sessionId}-${timestamp}`;
  const stepIds = new Map(); // step.id → full node ID
  const nodes = [];
  const edges = [];

  // Map step IDs to full node IDs
  for (const step of decomposed.steps) {
    stepIds.set(step.id, `${rootId}-${slugify(step.id)}`);
  }

  // Create step nodes
  for (let i = 0; i < decomposed.steps.length; i++) {
    const step = decomposed.steps[i];
    const nodeId = stepIds.get(step.id);
    const deps = (step.dependsOn || []).map(d => stepIds.get(d)).filter(Boolean);
    const children = decomposed.steps
      .filter(s => (s.dependsOn || []).includes(step.id))
      .map(s => stepIds.get(s.id));

    // Build node content using the same Traverse/Return pattern as the mapper
    let content = `# ${step.title}\n\n`;
    content += `> **Type:** execution-step | **Plan:** ${rootId}\n\n`;

    // Instruction block
    content += `## Instruction\n\n${step.instruction}\n\n`;

    // Condition (if any)
    if (step.condition) {
      content += `## Condition\n\n${step.condition}\n\n`;
    }

    // Traverse section — references to existing graph nodes + child steps
    const traverseEntries = [];

    // Existing graph nodes this step should read
    for (const ref of (step.references || [])) {
      const refNote = context.notes.find(n => n.id === ref);
      const label = refNote ? `${refNote.title} — ${(typeof refNote.summary === 'object' ? refNote.summary.body : refNote.summary || '').slice(0, 80)}` : ref;
      traverseEntries.push({ id: ref, label: `[existing] ${label}` });
    }

    // Child steps (steps that depend on this one)
    for (const childId of children) {
      const childStep = decomposed.steps.find(s => stepIds.get(s.id) === childId);
      if (childStep) {
        traverseEntries.push({ id: childId, label: `[step] ${childStep.title}` });
      }
    }

    if (traverseEntries.length > 0) {
      content += `## Traverse\n\n`;
      content += `Process each item below. Visit the link, execute its instructions, then return here.\n\n`;
      for (let j = 0; j < traverseEntries.length; j++) {
        content += `${j + 1}. [[${traverseEntries[j].id}]] — ${traverseEntries[j].label}\n`;
      }
      content += '\n';
    }

    // Return section — backlinks to parent steps
    if (deps.length > 0) {
      content += `## Return\n\n`;
      for (const dep of deps) {
        content += `← [[${dep}]]\n`;
      }
      content += `\nOn return, pass context: "Step \`${step.title}\` completed. Result: {describe findings}."\n`;
    }

    // Result placeholder (filled by the runtime)
    content += `\n## Result\n\n_Pending execution._\n`;

    // Save the node
    await kb.saveNote({
      id: nodeId,
      title: step.title,
      content,
      tags: ['temp', 'execution-step', `session:${sessionId}`],
      properties: {
        temp: true,
        type: 'execution-step',
        session: sessionId,
        plan: rootId,
        status: 'pending',
        stepId: step.id,
        dependsOn: step.dependsOn || [],
        condition: step.condition || null,
      },
    });

    nodes.push({
      id: nodeId,
      stepId: step.id,
      title: step.title,
      instruction: step.instruction,
      references: step.references || [],
      dependsOn: deps,
      condition: step.condition,
      status: 'pending',
    });

    // Record edges
    for (const dep of deps) {
      edges.push({ source: dep, target: nodeId, type: 'depends' });
    }
    for (const ref of (step.references || [])) {
      edges.push({ source: nodeId, target: ref, type: 'reference' });
    }
  }

  // 5. Create the root plan node (links to all entry-point steps)
  const entrySteps = nodes.filter(n => n.dependsOn.length === 0);
  const lastStep = nodes[nodes.length - 1];

  let rootContent = `# Plan: ${decomposed.title}\n\n`;
  rootContent += `> **Prompt:** ${prompt.slice(0, 300)}\n\n`;
  rootContent += `Execution graph with ${nodes.length} steps.\n\n`;
  rootContent += `## Traverse\n\n`;
  rootContent += `Execute the following entry points. Each step's ## Traverse section defines further control flow.\n\n`;
  for (let i = 0; i < entrySteps.length; i++) {
    rootContent += `${i + 1}. [[${entrySteps[i].id}]] — ${entrySteps[i].title}\n`;
  }
  if (lastStep && !entrySteps.find(e => e.id === lastStep.id)) {
    rootContent += `\nFinal synthesis: [[${lastStep.id}]] — ${lastStep.title}\n`;
  }
  rootContent += `\n## Result\n\n_Pending execution._\n`;

  await kb.saveNote({
    id: rootId,
    title: `Plan: ${decomposed.title}`,
    content: rootContent,
    tags: ['temp', 'plan', `session:${sessionId}`],
    properties: {
      temp: true,
      type: 'plan',
      session: sessionId,
      prompt: prompt.slice(0, 500),
      status: 'pending',
      stepCount: nodes.length,
    },
  });

  for (const entry of entrySteps) {
    edges.push({ source: rootId, target: entry.id, type: 'entry' });
  }

  onEvent({
    phase: 'build',
    message: `Built execution graph: ${nodes.length} steps, ${edges.length} edges`,
    rootId,
    nodes: nodes.map(n => ({ id: n.id, title: n.title })),
  });

  return {
    rootId,
    sessionId,
    title: decomposed.title,
    nodes,
    edges,
    entrySteps: entrySteps.map(n => n.id),
    finalStep: lastStep?.id,
  };
}

// ── Context builder ────────────────────────────────────────

async function buildContext(kb, prompt) {
  const all = new Map();

  // Keyword search
  const terms = prompt.replace(/[^\w\s-]/g, ' ').split(/\s+/).filter(w => w.length > 3).slice(0, 8);
  for (const term of terms) {
    for (const note of await kb.search(term)) {
      if (!note.id.startsWith('plan-') && !all.has(note.id)) all.set(note.id, note);
    }
  }

  // Semantic search
  try {
    const semantic = await kb.semanticSearch(prompt, { limit: 15 });
    for (const note of semantic) {
      if (!note.id.startsWith('plan-') && !all.has(note.id)) all.set(note.id, note);
    }
  } catch { /* vector index not built */ }

  // Recent notes for temporal context
  const recent = await kb.listNotes({ limit: 10 });
  for (const n of recent) {
    if (!n.id.startsWith('plan-') && !all.has(n.id)) all.set(n.id, n);
  }

  const notes = [...all.values()].slice(0, 30);
  const text = notes.map(n => {
    const summary = typeof n.summary === 'object' ? n.summary.body : (n.summary || '');
    return `- [[${n.id}]] "${n.title}" [${(n.tags || []).join(', ')}] — ${summary}`;
  }).join('\n');

  return { notes, text };
}

// ── LLM decomposition ─────────────────────────────────────

async function decompose(llm, prompt, contextText, maxNodes) {
  const filled = DECOMPOSE_PROMPT
    .replace('{{context}}', contextText || '(no existing nodes)')
    .replace(/\{\{prompt\}\}/g, prompt);

  const raw = await llm(filled);
  try {
    const clean = raw.replace(/```json\s*\n?/g, '').replace(/```\s*$/g, '').trim();
    const parsed = JSON.parse(clean);
    // Enforce max
    if (parsed.steps?.length > maxNodes) parsed.steps = parsed.steps.slice(0, maxNodes);
    return parsed;
  } catch {
    // Fallback: single-step plan
    return {
      title: prompt.slice(0, 60),
      steps: [{
        id: 'step-answer',
        title: 'Answer the prompt',
        instruction: `Answer this directly: ${prompt}`,
        references: [],
        dependsOn: [],
      }],
    };
  }
}

// ── LLM factory ────────────────────────────────────────────

function createLLM() {
  const config = loadConfig();
  const anthropicKey = config.api_key || process.env.ANTHROPIC_API_KEY;
  const openaiKey = config.openai_api_key || process.env.OPENAI_API_KEY;
  const baseUrl = config.llm_base_url || process.env.COMPOSIA_LLM_BASE_URL;
  const model = config.llm_model || process.env.COMPOSIA_LLM_MODEL || 'claude-haiku-4-5-20251001';

  if (anthropicKey) {
    return async (prompt) => {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ model, max_tokens: 2048, messages: [{ role: 'user', content: prompt }] }),
      });
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const data = await res.json();
      return data.content?.[0]?.text || '';
    };
  }

  if (openaiKey || baseUrl) {
    const url = (baseUrl || 'https://api.openai.com') + '/v1/chat/completions';
    return async (prompt) => {
      const headers = { 'Content-Type': 'application/json' };
      if (openaiKey) headers['Authorization'] = `Bearer ${openaiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, max_tokens: 2048, messages: [{ role: 'user', content: prompt }] }),
      });
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const data = await res.json();
      return data.choices?.[0]?.message?.content || '';
    };
  }

  return null;
}

export { createLLM };
