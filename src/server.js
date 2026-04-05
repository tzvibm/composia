import http from 'http';
import { createEngine } from './engine.js';
import { Knowledge } from './knowledge.js';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function jsonResponse(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body ? JSON.parse(body) : {}));
  });
}

export async function startServer({ dbPath, port = 3000 }) {
  const engine = await createEngine(dbPath);
  const kb = new Knowledge(engine);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const method = req.method;

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    try {
      // ── UI ───────────────────────────────────────────
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const html = readFileSync(path.join(__dirname, 'ui.html'), 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
        return;
      }

      // ── API: Notes ───────────────────────────────────
      if (url.pathname === '/api/notes' && method === 'GET') {
        const notes = await kb.listNotes({ limit: 1000 });
        return jsonResponse(res, notes);
      }

      if (url.pathname === '/api/notes' && method === 'POST') {
        const body = await readBody(req);
        const note = await kb.saveNote(body);
        return jsonResponse(res, note, 201);
      }

      if (url.pathname.startsWith('/api/notes/') && method === 'GET') {
        const id = decodeURIComponent(url.pathname.slice('/api/notes/'.length));
        const note = await kb.getNote(id);
        return jsonResponse(res, note);
      }

      if (url.pathname.startsWith('/api/notes/') && method === 'DELETE') {
        const id = decodeURIComponent(url.pathname.slice('/api/notes/'.length));
        await kb.deleteNote(id);
        return jsonResponse(res, { deleted: id });
      }

      // ── API: Links ───────────────────────────────────
      if (url.pathname.startsWith('/api/links/') && method === 'GET') {
        const id = decodeURIComponent(url.pathname.slice('/api/links/'.length));
        const links = await kb.getLinks(id);
        return jsonResponse(res, links);
      }

      // ── API: Graph ───────────────────────────────────
      if (url.pathname.startsWith('/api/graph/') && method === 'GET') {
        const id = decodeURIComponent(url.pathname.slice('/api/graph/'.length));
        const depth = parseInt(url.searchParams.get('depth') || '2', 10);
        const graph = await kb.getGraph(id, depth);
        return jsonResponse(res, graph);
      }

      if (url.pathname === '/api/graph' && method === 'GET') {
        // Full graph (all notes + all links)
        const notes = await kb.listNotes({ limit: 10000 });
        const nodes = notes.map(n => ({ id: n.id, title: n.title }));
        const edges = [];
        for (const note of notes) {
          const forward = await engine.getForwardLinks(note.id);
          for (const link of forward) {
            edges.push({ source: note.id, target: link.target });
          }
        }
        return jsonResponse(res, { nodes, edges });
      }

      // ── API: Search ──────────────────────────────────
      if (url.pathname === '/api/search' && method === 'GET') {
        const q = url.searchParams.get('q') || '';
        const results = await kb.search(q);
        return jsonResponse(res, results);
      }

      // ── API: Stats ───────────────────────────────────
      if (url.pathname === '/api/stats' && method === 'GET') {
        return jsonResponse(res, await kb.stats());
      }

      res.writeHead(404);
      res.end('Not found');
    } catch (err) {
      const status = err.code === 'LEVEL_NOT_FOUND' ? 404 : 500;
      jsonResponse(res, { error: err.message }, status);
    }
  });

  server.listen(port, () => {
    console.log(`Composia running at http://localhost:${port}`);
  });

  return { server, engine, kb };
}
