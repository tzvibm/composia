#!/usr/bin/env node

/**
 * composia init — Set up Composia in a project.
 *
 * Creates:
 *   .composia/db/         — RocksDB graph (gitignored)
 *   .composia/kb/         — Markdown knowledge base (committed to git)
 *   .composia/kb/README.md — Instructions for the kb folder
 *
 * Suggests configuration for:
 *   .claude/settings.json — MCP server + hooks
 *   .gitignore            — Ignore db folder
 */

import { mkdirSync, existsSync, writeFileSync, readFileSync, appendFileSync } from 'fs';
import path from 'path';

export function initProject(cwd = process.cwd()) {
  const composiaDir = path.join(cwd, '.composia');
  const dbDir = path.join(composiaDir, 'db');
  const kbDir = path.join(composiaDir, 'kb');
  const created = [];

  // Create directories
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
    created.push('.composia/db/');
  }
  if (!existsSync(kbDir)) {
    mkdirSync(kbDir, { recursive: true });
    created.push('.composia/kb/');
  }

  // Create KB readme
  const kbReadme = path.join(kbDir, 'README.md');
  if (!existsSync(kbReadme)) {
    writeFileSync(kbReadme, `# Knowledge Base

Put markdown files here to add them to the Composia knowledge graph.
Use \`composia ingest\` to import them, or they'll be picked up automatically.

## How to write notes

Use [[wikilinks]] to link between notes:

\`\`\`markdown
# Auth System

Our auth uses [[jwt-tokens]] with [[refresh-token-rotation]].
See [[api-gateway]] for how tokens are validated.

#architecture #auth
\`\`\`

## Folder structure

Organize however you like:
\`\`\`
kb/
├── architecture/     — System design decisions
├── patterns/         — Code patterns and conventions
├── bugs/             — Known issues and fixes
├── onboarding/       — New team member guides
└── decisions/        — ADRs (Architecture Decision Records)
\`\`\`

All .md files are ingested recursively. Filenames become note IDs.
`);
    created.push('.composia/kb/README.md');
  }

  // Update .gitignore
  const gitignore = path.join(cwd, '.gitignore');
  const ignoreEntry = '.composia/db/';
  if (existsSync(gitignore)) {
    const content = readFileSync(gitignore, 'utf-8');
    if (!content.includes(ignoreEntry)) {
      appendFileSync(gitignore, `\n# Composia graph database (binary, rebuilt from kb/)\n${ignoreEntry}\n`);
      created.push('.gitignore (updated)');
    }
  } else {
    writeFileSync(gitignore, `# Composia graph database (binary, rebuilt from kb/)\n${ignoreEntry}\n`);
    created.push('.gitignore (created)');
  }

  // Print setup instructions
  const config = {
    mcpServers: {
      composia: {
        command: 'node',
        args: [path.relative(cwd, path.join(cwd, 'node_modules', 'composia', 'src', 'mcp.js'))],
      },
    },
    hooks: {
      Stop: [{
        command: `node ${path.relative(cwd, path.join(cwd, 'node_modules', 'composia', 'src', 'hooks.js'))} post`,
        description: 'Capture session to Composia knowledge graph',
      }],
    },
  };

  return { created, config };
}
