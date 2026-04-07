/**
 * Composia Viewer — serves an interactive graph browser on localhost.
 * Zero dependencies beyond Node.js built-ins.
 */

import { createServer } from 'http';
import { createEngine } from './engine.js';
import { Knowledge } from './knowledge.js';

export async function startViewer(dbPath, { port = 3333, _engine } = {}) {
  const engine = _engine || await createEngine(dbPath);
  const ownsEngine = !_engine;
  const kb = new Knowledge(engine);

  // ── API handlers ──────────────────────────────────────

  async function apiList() {
    const notes = await kb.listNotes({ limit: 100000 });
    return notes.map(n => ({
      id: n.id, title: n.title, tags: n.tags,
      summary: n.summary?.body || '',
      level: n.properties?.level || '',
      path: n.properties?.path || '',
      children_count: n.properties?.children_count || 0,
    }));
  }

  async function apiNote(id) {
    const note = await kb.getNote(id);
    const { forward, backlinks } = await kb.getLinks(id);
    return { ...note, forward, backlinks };
  }

  async function apiGraph(id, depth) {
    return kb.getGraph(id, depth);
  }

  async function apiSemantic(query, limit) {
    const { VectorIndex } = await import('./vectors.js');
    const vecIndex = new VectorIndex(engine);
    return vecIndex.search(query, { limit });
  }

  async function apiRecall(query) {
    const { createResolver } = await import('./resolve.js');
    const resolver = createResolver(kb);
    if (!resolver) return { error: 'No API key configured. Run: composia config set api_key <key>' };
    const result = await resolver.resolve(query);
    return result;
  }

  async function apiSessions() {
    // Find all session tags
    const allNotes = await kb.listNotes({ limit: 100000 });
    const sessions = {};
    for (const note of allNotes) {
      const sessionTag = (note.tags || []).find(t => t.startsWith('session:'));
      if (sessionTag && (note.tags || []).includes('temp')) {
        const sid = sessionTag.replace('session:', '');
        if (!sessions[sid]) sessions[sid] = [];
        sessions[sid].push({
          id: note.id, title: note.title,
          prompt: note.properties?.prompt || '',
          created: note.created,
        });
      }
    }
    return Object.entries(sessions).map(([id, plans]) => ({
      id, plans: plans.sort((a, b) => (a.created || '').localeCompare(b.created || '')),
    }));
  }

  async function apiSessionGraph(sessionId) {
    const tag = `session:${sessionId}`;
    const noteIds = await engine.getNotesByTag(tag);
    const nodes = [];
    const edges = [];
    const seen = new Set();

    for (const id of noteIds) {
      try {
        const note = await engine.getNote(id);
        const { forward, backlinks } = await kb.getLinks(id);
        const summary = typeof note.summary === 'object' ? note.summary.body : (note.summary || '');
        nodes.push({
          id: note.id, title: note.title, summary,
          prompt: note.properties?.prompt || '',
          tags: note.tags || [],
          created: note.created,
          linkCount: forward.length,
          backlinkCount: backlinks.length,
        });
        seen.add(id);

        // Add linked nodes (the real graph nodes this plan references)
        for (const link of forward) {
          edges.push({ source: id, target: link.target });
          if (!seen.has(link.target)) {
            seen.add(link.target);
            try {
              const linked = await engine.getNote(link.target);
              const lSummary = typeof linked.summary === 'object' ? linked.summary.body : (linked.summary || '');
              nodes.push({
                id: linked.id, title: linked.title, summary: lSummary,
                tags: linked.tags || [], level: linked.properties?.level || '',
                confidence: linked.confidence,
                isPlan: false,
              });
            } catch {}
          }
        }
      } catch {}
    }

    // Mark plan nodes
    for (const n of nodes) {
      if (noteIds.includes(n.id)) n.isPlan = true;
    }

    return { sessionId, nodes, edges, planCount: noteIds.length };
  }

  // ── HTTP server ───────────────────────────────────────

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    try {
      if (url.pathname === '/api/list') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(await apiList()));
      } else if (url.pathname === '/api/note') {
        const id = url.searchParams.get('id');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(await apiNote(id)));
      } else if (url.pathname === '/api/graph') {
        const id = url.searchParams.get('id');
        const depth = parseInt(url.searchParams.get('depth') || '2', 10);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(await apiGraph(id, depth)));
      } else if (url.pathname === '/api/semantic') {
        const query = url.searchParams.get('q');
        const limit = parseInt(url.searchParams.get('limit') || '10', 10);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(await apiSemantic(query, limit)));
      } else if (url.pathname === '/api/recall') {
        const query = url.searchParams.get('q');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(await apiRecall(query)));
      } else if (url.pathname === '/api/sessions') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(await apiSessions()));
      } else if (url.pathname === '/api/session-graph') {
        const sid = url.searchParams.get('id');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(await apiSessionGraph(sid)));
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(HTML);
      }
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  server.listen(port, () => {
    console.log(`Composia viewer: http://localhost:${port}`);
  });

  return { server, engine, port };
}

// ── Single-page HTML app ───────────────────────────────��

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Composia — Knowledge Graph</title>
<style>
  :root {
    --bg: #0d1117; --surface: #161b22; --border: #30363d;
    --text: #e6edf3; --dim: #8b949e; --accent: #58a6ff;
    --green: #3fb950; --purple: #bc8cff; --orange: #d29922;
    --red: #f85149; --cyan: #39d353;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    background: var(--bg); color: var(--text); display: flex; height: 100vh; overflow: hidden; }

  /* ── Sidebar ─────────────────── */
  #sidebar { width: 320px; min-width: 260px; border-right: 1px solid var(--border);
    display: flex; flex-direction: column; background: var(--surface); }
  #sidebar h1 { padding: 16px; font-size: 16px; border-bottom: 1px solid var(--border);
    display: flex; align-items: center; gap: 8px; }
  #sidebar h1 span { color: var(--accent); }
  #search { padding: 8px 16px; border-bottom: 1px solid var(--border); }
  #search input { width: 100%; padding: 8px 12px; background: var(--bg); border: 1px solid var(--border);
    border-radius: 6px; color: var(--text); font-size: 13px; outline: none; }
  #search input:focus { border-color: var(--accent); }
  #filters { padding: 8px 16px; display: flex; gap: 6px; flex-wrap: wrap; border-bottom: 1px solid var(--border); }
  .filter-btn { padding: 3px 10px; border-radius: 12px; border: 1px solid var(--border);
    background: transparent; color: var(--dim); cursor: pointer; font-size: 12px; }
  .filter-btn.active { background: var(--accent); color: var(--bg); border-color: var(--accent); }
  #tree { flex: 1; overflow-y: auto; padding: 8px 0; }
  .tree-item { padding: 6px 16px; cursor: pointer; display: flex; align-items: center; gap: 8px;
    font-size: 13px; border-left: 3px solid transparent; }
  .tree-item:hover { background: rgba(88,166,255,0.08); }
  .tree-item.active { background: rgba(88,166,255,0.12); border-left-color: var(--accent); }
  .tree-item .badge { font-size: 10px; padding: 1px 6px; border-radius: 8px; background: var(--border); color: var(--dim); }
  .tree-item .badge.project { background: #1f3a5f; color: var(--accent); }
  .tree-item .badge.directory { background: #1a3524; color: var(--green); }
  .tree-item .badge.file { background: #2a1f3f; color: var(--purple); }
  .tree-item .badge.class { background: #3a2a0f; color: var(--orange); }
  .tree-item .badge.function { background: #3a0f1f; color: var(--red); }
  .tree-item .badge.method { background: #0f2a3a; color: var(--cyan); }
  .tree-item .badge.interface { background: #2a2a0f; color: #d2a822; }

  /* ── Main area ───────────────── */
  #main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
  #toolbar { padding: 12px 24px; border-bottom: 1px solid var(--border); display: flex;
    align-items: center; gap: 12px; background: var(--surface); }
  #breadcrumbs { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }
  .crumb { color: var(--accent); cursor: pointer; font-size: 13px; }
  .crumb:hover { text-decoration: underline; }
  .crumb-sep { color: var(--dim); font-size: 13px; }
  #content { flex: 1; overflow-y: auto; padding: 24px; }

  /* ── Note view ───────────────── */
  .note-header { margin-bottom: 20px; }
  .note-header h2 { font-size: 22px; margin-bottom: 8px; }
  .note-meta { display: flex; gap: 12px; flex-wrap: wrap; color: var(--dim); font-size: 13px; }
  .note-meta .tag { color: var(--green); }
  .note-summary { background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
    padding: 16px; margin-bottom: 20px; font-size: 14px; line-height: 1.6; }
  .note-section { margin-bottom: 24px; }
  .note-section h3 { font-size: 14px; color: var(--dim); text-transform: uppercase; letter-spacing: 1px;
    margin-bottom: 12px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }

  /* ── Link cards ──────────────── */
  .link-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 10px; }
  .link-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
    padding: 12px 16px; cursor: pointer; transition: border-color 0.15s; }
  .link-card:hover { border-color: var(--accent); }
  .link-card .lc-title { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
  .link-card .lc-summary { font-size: 12px; color: var(--dim); line-height: 1.4;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .link-card .lc-badge { display: inline-block; font-size: 10px; padding: 1px 6px;
    border-radius: 8px; margin-right: 6px; }

  /* ── Graph canvas ────────────── */
  #graph-container { position: relative; width: 100%; height: 400px; background: var(--surface);
    border: 1px solid var(--border); border-radius: 8px; overflow: hidden; margin-bottom: 20px; }
  #graph-canvas { width: 100%; height: 100%; }

  /* ── Empty state ─────────��───── */
  .empty { display: flex; align-items: center; justify-content: center; height: 100%;
    color: var(--dim); font-size: 16px; flex-direction: column; gap: 8px; }
  .empty small { font-size: 13px; }

  /* ── Stats bar ───────────────── */
  #stats { padding: 8px 16px; border-top: 1px solid var(--border); font-size: 12px; color: var(--dim);
    background: var(--surface); display: flex; gap: 16px; }

  /* ── Tabs ────────────────────── */
  #tabs { display: flex; border-bottom: 1px solid var(--border); }
  .tab { flex: 1; padding: 10px; text-align: center; cursor: pointer; font-size: 13px;
    color: var(--dim); border-bottom: 2px solid transparent; transition: all 0.15s; }
  .tab:hover { color: var(--text); background: rgba(88,166,255,0.04); }
  .tab.active { color: var(--accent); border-bottom-color: var(--accent); }
  .tab .tab-count { font-size: 11px; background: var(--border); padding: 1px 6px;
    border-radius: 8px; margin-left: 4px; }

  /* ── Session list ───────────── */
  #session-list { flex: 1; overflow-y: auto; padding: 8px 0; display: none; }
  #session-list.visible { display: block; }
  .session-item { padding: 10px 16px; cursor: pointer; border-left: 3px solid transparent;
    border-bottom: 1px solid var(--border); }
  .session-item:hover { background: rgba(88,166,255,0.08); }
  .session-item.active { border-left-color: var(--accent); background: rgba(88,166,255,0.12); }
  .session-item .si-id { font-size: 11px; color: var(--dim); font-family: monospace; }
  .session-item .si-plans { font-size: 12px; margin-top: 4px; color: var(--text); }
  .session-item .si-count { font-size: 11px; color: var(--dim); }

  /* ── Session detail ─────────── */
  .session-header { margin-bottom: 20px; }
  .session-header h2 { font-size: 20px; margin-bottom: 8px; }
  .session-header .sh-meta { font-size: 13px; color: var(--dim); }
  .plan-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
    padding: 16px; margin-bottom: 12px; }
  .plan-card.is-plan { border-left: 3px solid var(--purple); }
  .plan-card .pc-title { font-size: 15px; font-weight: 600; margin-bottom: 6px; }
  .plan-card .pc-prompt { font-size: 13px; color: var(--dim); margin-bottom: 8px; font-style: italic; }
  .plan-card .pc-summary { font-size: 13px; line-height: 1.5; margin-bottom: 8px; }
  .plan-card .pc-links { font-size: 12px; color: var(--dim); }
  .plan-card .pc-links a { color: var(--accent); cursor: pointer; text-decoration: none; }
  .plan-card .pc-links a:hover { text-decoration: underline; }
  .plan-card .pc-tags { margin-top: 6px; }
  .plan-card .pc-tag { font-size: 11px; padding: 1px 6px; border-radius: 8px;
    background: var(--border); color: var(--dim); margin-right: 4px; }
  .plan-card .pc-tag.plan { background: #2a1f3f; color: var(--purple); }
  .plan-card .pc-confidence { font-size: 11px; color: var(--orange); }
  .session-live { font-size: 11px; color: var(--green); margin-left: 8px; }
</style>
</head>
<body>

<div id="sidebar">
  <h1><span>&#9670;</span> Composia</h1>
  <div id="tabs">
    <div class="tab active" data-tab="graph">Graph</div>
    <div class="tab" data-tab="sessions">Sessions<span class="tab-count" id="session-count">0</span></div>
  </div>
  <div id="graph-tab">
    <div id="search"><input type="text" placeholder="Search notes..." id="searchInput"></div>
    <div id="filters"></div>
    <div id="tree"></div>
  </div>
  <div id="session-list"></div>
  <div id="stats"></div>
</div>

<div id="main">
  <div id="toolbar"><div id="breadcrumbs"></div></div>
  <div id="content">
    <div class="empty">
      <div>Select a node from the sidebar</div>
      <small>or click a map root to start traversing</small>
    </div>
  </div>
</div>

<script>
const state = { notes: [], current: null, filter: null, history: [], tab: 'graph', sessions: [], currentSession: null };

// ── API ─────────────────��────────
async function api(path) {
  const r = await fetch(path);
  return r.json();
}

// ── Init ─────────────────────────
async function init() {
  state.notes = await api('/api/list');
  renderFilters();
  renderTree();
  renderStats();

  document.getElementById('searchInput').addEventListener('input', renderTree);

  // Tab switching
  document.getElementById('tabs').addEventListener('click', e => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    state.tab = tab.dataset.tab;
    document.getElementById('graph-tab').style.display = state.tab === 'graph' ? '' : 'none';
    document.getElementById('session-list').style.display = state.tab === 'sessions' ? 'block' : 'none';
    if (state.tab === 'sessions') loadSessions();
  });

  await loadSessions();

  // Auto-select root map node if exists
  const root = state.notes.find(n => n.level === 'project');
  if (root) selectNote(root.id);

  // Poll for session updates every 3s
  setInterval(async () => {
    if (state.tab === 'sessions') await loadSessions();
    if (state.currentSession) await loadSessionGraph(state.currentSession);
  }, 3000);
}

// ── Filters ──────────────────────
function renderFilters() {
  const levels = [...new Set(state.notes.map(n => n.level).filter(Boolean))];
  const el = document.getElementById('filters');
  el.innerHTML = '<button class="filter-btn active" data-filter="">All</button>' +
    levels.map(l => '<button class="filter-btn" data-filter="' + l + '">' + l + '</button>').join('');
  el.addEventListener('click', e => {
    if (!e.target.classList.contains('filter-btn')) return;
    el.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    e.target.classList.add('active');
    state.filter = e.target.dataset.filter || null;
    renderTree();
  });
}

// ── Sidebar tree ─────────────────
function renderTree() {
  const q = document.getElementById('searchInput').value.toLowerCase();
  let notes = state.notes;

  if (state.filter) notes = notes.filter(n => n.level === state.filter);
  if (q) notes = notes.filter(n =>
    n.title.toLowerCase().includes(q) || n.id.toLowerCase().includes(q) ||
    n.summary.toLowerCase().includes(q) || (n.tags || []).some(t => t.includes(q))
  );

  // Sort: project first, then directories, then files, then constructs
  const order = { project: 0, directory: 1, file: 2, class: 3, interface: 4, function: 5, type: 6, method: 7 };
  notes.sort((a, b) => (order[a.level] ?? 99) - (order[b.level] ?? 99) || a.id.localeCompare(b.id));

  const el = document.getElementById('tree');
  el.innerHTML = notes.map(n => {
    const active = state.current === n.id ? ' active' : '';
    const badge = n.level || 'note';
    return '<div class="tree-item' + active + '" data-id="' + n.id + '">' +
      '<span class="badge ' + badge + '">' + badge + '</span>' +
      '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(n.title) + '</span>' +
      (n.children_count ? '<span class="badge">' + n.children_count + '</span>' : '') +
      '</div>';
  }).join('');

  el.addEventListener('click', e => {
    const item = e.target.closest('.tree-item');
    if (item) selectNote(item.dataset.id);
  });
}

// ── Select & render note ─────────
async function selectNote(id) {
  state.current = id;
  renderTree();

  const note = await api('/api/note?id=' + encodeURIComponent(id));
  const graph = await api('/api/graph?id=' + encodeURIComponent(id) + '&depth=1');

  renderBreadcrumbs(note);
  renderNote(note, graph);
}

function renderBreadcrumbs(note) {
  const el = document.getElementById('breadcrumbs');
  // Build path from backlinks (parent chain)
  const crumbs = [];
  if (note.properties?.path && note.properties.path !== '.') {
    const parts = note.properties.path.split('/');
    crumbs.push(...parts.slice(0, -1));
  }
  crumbs.push(note.title);

  el.innerHTML = crumbs.map((c, i) =>
    (i > 0 ? '<span class="crumb-sep">/</span>' : '') +
    '<span class="crumb">' + esc(c) + '</span>'
  ).join('');
}

function renderNote(note, graph) {
  const el = document.getElementById('content');
  const level = note.properties?.level || '';
  const badge = '<span class="badge ' + level + '" style="font-size:12px;padding:2px 8px;vertical-align:middle">' + level + '</span>';

  let html = '<div class="note-header">';
  html += '<h2>' + badge + ' ' + esc(note.title) + '</h2>';
  html += '<div class="note-meta">';
  if (note.properties?.path) html += '<span>Path: <code>' + esc(note.properties.path) + '</code></span>';
  if (note.properties?.language) html += '<span>Language: ' + esc(note.properties.language) + '</span>';
  if (note.tags?.length) html += '<span>' + note.tags.map(t => '<span class="tag">#' + t + '</span>').join(' ') + '</span>';
  html += '</div></div>';

  // Summary
  if (note.summary?.body) {
    html += '<div class="note-summary">' + esc(note.summary.body) + '</div>';
  }

  // Graph visualization
  if (graph.nodes?.length > 1) {
    html += '<div class="note-section"><h3>Graph</h3>';
    html += '<div id="graph-container"><canvas id="graph-canvas"></canvas></div></div>';
  }

  // Forward links (children / traverse targets)
  if (note.forward?.length) {
    html += '<div class="note-section"><h3>Links To (' + note.forward.length + ')</h3>';
    html += '<div class="link-grid">';
    for (const link of note.forward) {
      const linked = state.notes.find(n => n.id === link.target);
      const lLevel = linked?.level || '';
      html += '<div class="link-card" data-id="' + esc(link.target) + '">';
      html += '<div class="lc-title"><span class="lc-badge badge ' + lLevel + '">' + lLevel + '</span>' + esc(linked?.title || link.target) + '</div>';
      html += '<div class="lc-summary">' + esc(linked?.summary || '') + '</div>';
      html += '</div>';
    }
    html += '</div></div>';
  }

  // Backlinks (parents / who links here)
  if (note.backlinks?.length) {
    html += '<div class="note-section"><h3>Linked From (' + note.backlinks.length + ')</h3>';
    html += '<div class="link-grid">';
    for (const link of note.backlinks) {
      const linked = state.notes.find(n => n.id === link.source);
      const lLevel = linked?.level || '';
      html += '<div class="link-card" data-id="' + esc(link.source) + '">';
      html += '<div class="lc-title"><span class="lc-badge badge ' + lLevel + '">' + lLevel + '</span>' + esc(linked?.title || link.source) + '</div>';
      html += '<div class="lc-summary">' + esc(linked?.summary || '') + '</div>';
      html += '</div>';
    }
    html += '</div></div>';
  }

  el.innerHTML = html;

  // Make link cards clickable
  el.querySelectorAll('.link-card').forEach(card => {
    card.addEventListener('click', () => selectNote(card.dataset.id));
  });

  // Draw graph if present
  if (graph.nodes?.length > 1) {
    requestAnimationFrame(() => drawGraph(graph, note.id));
  }
}

// ── Simple force-directed graph ──
function drawGraph(graph, centerId) {
  const canvas = document.getElementById('graph-canvas');
  if (!canvas) return;
  const container = document.getElementById('graph-container');
  canvas.width = container.offsetWidth;
  canvas.height = container.offsetHeight;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;

  const colors = {
    project: '#58a6ff', directory: '#3fb950', file: '#bc8cff',
    class: '#d29922', function: '#f85149', method: '#39d353',
    interface: '#d2a822', type: '#8b949e',
  };

  // Position nodes
  const nodeMap = {};
  const centerX = W / 2, centerY = H / 2;
  graph.nodes.forEach((n, i) => {
    const angle = (i / graph.nodes.length) * Math.PI * 2;
    const r = n.id === centerId ? 0 : 120 + Math.random() * 60;
    nodeMap[n.id] = {
      ...n,
      x: centerX + Math.cos(angle) * r,
      y: centerY + Math.sin(angle) * r,
      vx: 0, vy: 0,
    };
  });

  // Simple force simulation (few iterations)
  for (let iter = 0; iter < 80; iter++) {
    // Repulsion between all nodes
    const nodes = Object.values(nodeMap);
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[j].x - nodes[i].x;
        const dy = nodes[j].y - nodes[i].y;
        const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
        const force = 800 / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        nodes[i].vx -= fx; nodes[i].vy -= fy;
        nodes[j].vx += fx; nodes[j].vy += fy;
      }
    }
    // Attraction along edges
    for (const edge of graph.edges) {
      const a = nodeMap[edge.source], b = nodeMap[edge.target];
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
      const force = (dist - 100) * 0.01;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
    }
    // Center gravity
    for (const n of nodes) {
      n.vx += (centerX - n.x) * 0.005;
      n.vy += (centerY - n.y) * 0.005;
      n.x += n.vx * 0.3; n.y += n.vy * 0.3;
      n.vx *= 0.8; n.vy *= 0.8;
      n.x = Math.max(40, Math.min(W - 40, n.x));
      n.y = Math.max(20, Math.min(H - 20, n.y));
    }
  }

  // Draw edges
  ctx.strokeStyle = '#30363d';
  ctx.lineWidth = 1;
  for (const edge of graph.edges) {
    const a = nodeMap[edge.source], b = nodeMap[edge.target];
    if (!a || !b) continue;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  // Draw nodes
  for (const n of Object.values(nodeMap)) {
    const isCenter = n.id === centerId;
    const level = n.tags?.find(t => ['project','directory','file','class','function','method','interface','type'].includes(t)) || '';
    const color = colors[level] || '#8b949e';
    const radius = isCenter ? 8 : 5;

    ctx.beginPath();
    ctx.arc(n.x, n.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    if (isCenter) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke(); }

    ctx.fillStyle = '#e6edf3';
    ctx.font = (isCenter ? 'bold ' : '') + '11px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    const label = n.title || n.id;
    ctx.fillText(label.length > 20 ? label.slice(0, 18) + '..' : label, n.x, n.y - radius - 4);
  }

  // Click handler
  canvas.onclick = (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    for (const n of Object.values(nodeMap)) {
      const dx = n.x - mx, dy = n.y - my;
      if (dx * dx + dy * dy < 200) { selectNote(n.id); return; }
    }
  };
  canvas.style.cursor = 'pointer';
}

// ── Stats ────────────────────────
function renderStats() {
  const el = document.getElementById('stats');
  const levels = {};
  state.notes.forEach(n => { levels[n.level || 'other'] = (levels[n.level || 'other'] || 0) + 1; });
  el.innerHTML = Object.entries(levels).map(([k, v]) => k + ': ' + v).join(' &middot; ') +
    ' &middot; total: ' + state.notes.length;
}

function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ── Sessions ────────────────────
async function loadSessions() {
  const sessions = await api('/api/sessions');
  state.sessions = sessions;
  document.getElementById('session-count').textContent = sessions.length;
  renderSessionList();
}

function renderSessionList() {
  const el = document.getElementById('session-list');
  if (state.sessions.length === 0) {
    el.innerHTML = '<div style="padding:16px;color:var(--dim);font-size:13px">No active sessions. Start one with <code>composia chat</code></div>';
    return;
  }
  el.innerHTML = state.sessions.map(s => {
    const active = state.currentSession === s.id ? ' active' : '';
    const latest = s.plans[s.plans.length - 1];
    return '<div class="session-item' + active + '" data-sid="' + esc(s.id) + '">' +
      '<div class="si-id">' + esc(s.id) + '</div>' +
      '<div class="si-plans">' + esc(latest?.title || 'No plans yet') + '</div>' +
      '<div class="si-count">' + s.plans.length + ' plan' + (s.plans.length !== 1 ? 's' : '') + '</div>' +
      '</div>';
  }).join('');
  el.querySelectorAll('.session-item').forEach(item => {
    item.addEventListener('click', () => {
      state.currentSession = item.dataset.sid;
      renderSessionList();
      loadSessionGraph(item.dataset.sid);
    });
  });
}

async function loadSessionGraph(sessionId) {
  const data = await api('/api/session-graph?id=' + encodeURIComponent(sessionId));
  renderSessionDetail(data);
}

function renderSessionDetail(data) {
  const el = document.getElementById('content');
  let html = '<div class="session-header">';
  html += '<h2>Session<span class="session-live">LIVE</span></h2>';
  html += '<div class="sh-meta">' + esc(data.sessionId) + ' &middot; ' + data.planCount + ' plans &middot; ' + data.nodes.length + ' total nodes &middot; ' + data.edges.length + ' edges</div>';
  html += '</div>';

  // Graph visualization
  if (data.nodes.length > 0) {
    html += '<div class="note-section"><h3>Session Graph</h3>';
    html += '<div id="graph-container"><canvas id="graph-canvas"></canvas></div></div>';
  }

  // Plan nodes first (the user's turns)
  const plans = data.nodes.filter(n => n.isPlan);
  const referenced = data.nodes.filter(n => !n.isPlan);

  if (plans.length > 0) {
    html += '<div class="note-section"><h3>Plans (' + plans.length + ')</h3>';
    for (const node of plans) {
      html += '<div class="plan-card is-plan">';
      html += '<div class="pc-title">' + esc(node.title) + '</div>';
      if (node.prompt) html += '<div class="pc-prompt">"' + esc(node.prompt) + '"</div>';
      if (node.summary) html += '<div class="pc-summary">' + esc(node.summary) + '</div>';
      const nodeEdges = data.edges.filter(e => e.source === node.id);
      if (nodeEdges.length > 0) {
        html += '<div class="pc-links">Links to: ' + nodeEdges.map(e => {
          const target = data.nodes.find(n => n.id === e.target);
          return '<a data-id="' + esc(e.target) + '">' + esc(target?.title || e.target) + '</a>';
        }).join(', ') + '</div>';
      }
      html += '<div class="pc-tags">';
      for (const t of (node.tags || [])) {
        html += '<span class="pc-tag' + (t === 'plan' ? ' plan' : '') + '">' + esc(t) + '</span>';
      }
      html += '</div></div>';
    }
    html += '</div>';
  }

  // Referenced graph nodes
  if (referenced.length > 0) {
    html += '<div class="note-section"><h3>Referenced Nodes (' + referenced.length + ')</h3>';
    html += '<div class="link-grid">';
    for (const node of referenced) {
      const level = node.level || '';
      html += '<div class="link-card" data-id="' + esc(node.id) + '">';
      html += '<div class="lc-title"><span class="lc-badge badge ' + level + '">' + level + '</span>' + esc(node.title) + '</div>';
      if (node.summary) html += '<div class="lc-summary">' + esc(node.summary) + '</div>';
      if (node.confidence != null && node.confidence < 1) {
        html += '<div class="pc-confidence">confidence: ' + node.confidence.toFixed(2) + '</div>';
      }
      html += '</div>';
    }
    html += '</div></div>';
  }

  el.innerHTML = html;

  // Click handlers for links
  el.querySelectorAll('.pc-links a, .link-card').forEach(link => {
    link.addEventListener('click', () => {
      const id = link.dataset.id;
      if (id) selectNote(id);
    });
  });

  // Draw session graph
  if (data.nodes.length > 0) {
    requestAnimationFrame(() => drawSessionGraph(data));
  }
}

function drawSessionGraph(data) {
  const canvas = document.getElementById('graph-canvas');
  if (!canvas) return;
  const container = document.getElementById('graph-container');
  canvas.width = container.offsetWidth;
  canvas.height = container.offsetHeight;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;

  const nodeMap = {};
  const centerX = W / 2, centerY = H / 2;
  data.nodes.forEach((n, i) => {
    const angle = (i / data.nodes.length) * Math.PI * 2;
    const r = n.isPlan ? 50 + i * 30 : 120 + Math.random() * 80;
    nodeMap[n.id] = { ...n, x: centerX + Math.cos(angle) * r, y: centerY + Math.sin(angle) * r, vx: 0, vy: 0 };
  });

  // Force simulation
  for (let iter = 0; iter < 100; iter++) {
    const nodes = Object.values(nodeMap);
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[j].x - nodes[i].x, dy = nodes[j].y - nodes[i].y;
        const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
        const force = 1200 / (dist * dist);
        nodes[i].vx -= (dx / dist) * force; nodes[i].vy -= (dy / dist) * force;
        nodes[j].vx += (dx / dist) * force; nodes[j].vy += (dy / dist) * force;
      }
    }
    for (const edge of data.edges) {
      const a = nodeMap[edge.source], b = nodeMap[edge.target];
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
      const force = (dist - 120) * 0.008;
      a.vx += (dx / dist) * force; a.vy += (dy / dist) * force;
      b.vx -= (dx / dist) * force; b.vy -= (dy / dist) * force;
    }
    for (const n of nodes) {
      n.vx += (centerX - n.x) * 0.003; n.vy += (centerY - n.y) * 0.003;
      n.x += n.vx * 0.3; n.y += n.vy * 0.3;
      n.vx *= 0.75; n.vy *= 0.75;
      n.x = Math.max(50, Math.min(W - 50, n.x));
      n.y = Math.max(25, Math.min(H - 25, n.y));
    }
  }

  // Draw edges
  ctx.lineWidth = 1;
  for (const edge of data.edges) {
    const a = nodeMap[edge.source], b = nodeMap[edge.target];
    if (!a || !b) continue;
    ctx.strokeStyle = a.isPlan ? '#bc8cff44' : '#30363d';
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    // Arrow
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.moveTo(mx + 5 * Math.cos(angle), my + 5 * Math.sin(angle));
    ctx.lineTo(mx - 4 * Math.cos(angle - 0.5), my - 4 * Math.sin(angle - 0.5));
    ctx.lineTo(mx - 4 * Math.cos(angle + 0.5), my - 4 * Math.sin(angle + 0.5));
    ctx.fill();
  }

  // Draw nodes
  const colors = { project: '#58a6ff', directory: '#3fb950', file: '#bc8cff', class: '#d29922', function: '#f85149', method: '#39d353' };
  for (const n of Object.values(nodeMap)) {
    const radius = n.isPlan ? 10 : 6;
    const color = n.isPlan ? '#bc8cff' : (colors[n.level] || '#8b949e');

    ctx.beginPath(); ctx.arc(n.x, n.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
    if (n.isPlan) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke(); ctx.lineWidth = 1; }

    ctx.fillStyle = '#e6edf3';
    ctx.font = (n.isPlan ? 'bold ' : '') + '10px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    const label = n.title || n.id;
    ctx.fillText(label.length > 25 ? label.slice(0, 23) + '..' : label, n.x, n.y - radius - 4);
  }

  canvas.onclick = (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    for (const n of Object.values(nodeMap)) {
      const dx = n.x - mx, dy = n.y - my;
      if (dx * dx + dy * dy < 200) { selectNote(n.id); return; }
    }
  };
  canvas.style.cursor = 'pointer';
}

init();
</script>
</body>
</html>`;
