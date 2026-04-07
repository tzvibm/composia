import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createEngine } from '../src/engine.js';
import { Knowledge } from '../src/knowledge.js';
import { mapDirectory } from '../src/mapper.js';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import path from 'path';

const TEST_DB = path.join(process.cwd(), '.composia-test-mapper');
const TEST_DIR = path.join(process.cwd(), '.composia-test-mapper-src');

describe('Mapper', () => {
  let engine, kb;

  beforeEach(async () => {
    rmSync(TEST_DB, { recursive: true, force: true });
    rmSync(TEST_DIR, { recursive: true, force: true });
    engine = await createEngine(TEST_DB);
    kb = new Knowledge(engine);

    // Create a small test codebase
    mkdirSync(path.join(TEST_DIR, 'src'), { recursive: true });
    mkdirSync(path.join(TEST_DIR, 'tests'), { recursive: true });

    writeFileSync(path.join(TEST_DIR, 'package.json'), JSON.stringify({ name: 'test-project' }));

    writeFileSync(path.join(TEST_DIR, 'src', 'server.js'), `
import { Database } from './db.js';

export class Server {
  constructor(port) {
    this.port = port;
    this.db = new Database();
  }

  async start() {
    console.log('Starting on', this.port);
  }

  async stop() {
    await this.db.close();
  }
}

export function createServer(port) {
  return new Server(port);
}
`);

    writeFileSync(path.join(TEST_DIR, 'src', 'db.js'), `
export class Database {
  async connect() {}
  async query(sql) {}
  async close() {}
}
`);

    writeFileSync(path.join(TEST_DIR, 'tests', 'server.test.js'), `
import { createServer } from '../src/server.js';

function setup() {
  return createServer(3000);
}
`);
  });

  afterEach(async () => {
    await engine.close();
    rmSync(TEST_DB, { recursive: true, force: true });
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('maps a directory into a knowledge graph', async () => {
    const result = await mapDirectory(TEST_DIR, kb, { summarize: false });

    expect(result.notes).toBeGreaterThan(0);
    expect(result.links).toBeGreaterThan(0);
    expect(result.root).toBeTruthy();
  });

  it('creates a root project node', async () => {
    const result = await mapDirectory(TEST_DIR, kb, { summarize: false });
    const root = await kb.getNote(result.root);

    expect(root).toBeTruthy();
    expect(root.tags).toContain('map');
    expect(root.tags).toContain('project');
    expect(root.properties.level).toBe('project');
    expect(root.content).toContain('## Traverse');
  });

  it('creates directory nodes with children', async () => {
    await mapDirectory(TEST_DIR, kb, { summarize: false });
    const srcNodes = await kb.findByTag('directory');
    expect(srcNodes.length).toBeGreaterThanOrEqual(2); // src/ and tests/

    const srcNode = srcNodes.find(n => n.title === 'src');
    expect(srcNode).toBeTruthy();
    expect(srcNode.content).toContain('## Traverse');
    expect(srcNode.content).toContain('server.js');
    expect(srcNode.content).toContain('db.js');
  });

  it('creates file nodes with constructs', async () => {
    await mapDirectory(TEST_DIR, kb, { summarize: false });
    const fileNodes = await kb.findByTag('file');
    expect(fileNodes.length).toBe(4); // server.js, db.js, server.test.js, package.json

    const serverFile = fileNodes.find(n => n.title === 'server.js');
    expect(serverFile).toBeTruthy();
    expect(serverFile.content).toContain('Server');
    expect(serverFile.content).toContain('createServer');
  });

  it('creates class and function construct nodes', async () => {
    await mapDirectory(TEST_DIR, kb, { summarize: false });
    const classNodes = await kb.findByTag('class');
    expect(classNodes.length).toBeGreaterThanOrEqual(2); // Server, Database

    const serverClass = classNodes.find(n => n.title === 'Server');
    expect(serverClass).toBeTruthy();
    expect(serverClass.content).toContain('method');
  });

  it('creates method nodes as leaves', async () => {
    await mapDirectory(TEST_DIR, kb, { summarize: false });
    const methodNodes = await kb.findByTag('method');
    expect(methodNodes.length).toBeGreaterThan(0);

    // Server should have: constructor, start, stop
    const startMethod = methodNodes.find(n => n.title === 'Server.start');
    expect(startMethod).toBeTruthy();
    expect(startMethod.content).toContain('## Return');
    expect(startMethod.content).toContain('[[');
  });

  it('has backlinks connecting children to parents', async () => {
    const result = await mapDirectory(TEST_DIR, kb, { summarize: false });

    // The root should have backlinks from its directory children
    const { backlinks } = await kb.getLinks(result.root);
    expect(backlinks.length).toBeGreaterThan(0);
  });

  it('has forward links from traverse lists', async () => {
    const result = await mapDirectory(TEST_DIR, kb, { summarize: false });
    const { forward } = await kb.getLinks(result.root);
    expect(forward.length).toBeGreaterThan(0);
  });

  it('nodes contain return navigation instructions', async () => {
    await mapDirectory(TEST_DIR, kb, { summarize: false });
    const fileNodes = await kb.findByTag('file');
    for (const node of fileNodes) {
      expect(node.content).toContain('## Return');
      expect(node.content).toContain('← [[');
      expect(node.content).toContain('On return, pass context');
    }
  });

  it('nodes contain sibling navigation', async () => {
    await mapDirectory(TEST_DIR, kb, { summarize: false });
    const fileNodes = await kb.findByTag('file');

    // At least one file should have "Continue to" (not the last sibling)
    const hasNext = fileNodes.some(n => n.content.includes('Continue to:'));
    expect(hasNext).toBe(true);
  });

  it('respects prefix option', async () => {
    const result = await mapDirectory(TEST_DIR, kb, { prefix: 'code', summarize: false });
    expect(result.root).toMatch(/^code-/);
  });

  it('reports correct construct count', async () => {
    const result = await mapDirectory(TEST_DIR, kb, { summarize: false });
    // Server class, Database class, createServer func, setup func + methods
    expect(result.constructs).toBeGreaterThanOrEqual(4);
  });
});
