"""SQLite-based graph store with nodes, edges, tags, and history."""

import json
import math
import sqlite3
from datetime import datetime

from .models import Node, Edge
from .config import (
    DECAY_HALF_LIFE_DAYS, REINFORCE_WEIGHT, REINFORCE_CONFIDENCE,
    MAX_CONFIDENCE, MIN_CONFIDENCE_ACTIVE,
)


SCHEMA = """
CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    layer TEXT NOT NULL CHECK(layer IN ('system', 'session', 'prompt')),
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    summary TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    properties TEXT DEFAULT '{}',
    weight REAL DEFAULT 1.0,
    confidence REAL DEFAULT 1.0,
    access_count INTEGER DEFAULT 0,
    created TEXT NOT NULL,
    updated TEXT NOT NULL,
    last_accessed TEXT NOT NULL,
    supersedes TEXT
);

CREATE INDEX IF NOT EXISTS idx_nodes_layer ON nodes(layer);
CREATE INDEX IF NOT EXISTS idx_nodes_confidence ON nodes(confidence);

CREATE TABLE IF NOT EXISTS edges (
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    weight REAL DEFAULT 1.0,
    edge_type TEXT DEFAULT '',
    context TEXT DEFAULT '',
    last_seen TEXT NOT NULL,
    PRIMARY KEY (source_id, target_id)
);

CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);

CREATE TABLE IF NOT EXISTS tags (
    tag TEXT NOT NULL,
    node_id TEXT NOT NULL,
    PRIMARY KEY (tag, node_id)
);

CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);

CREATE TABLE IF NOT EXISTS history (
    node_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    PRIMARY KEY (node_id, timestamp)
);
"""


def _now():
    return datetime.utcnow().isoformat()


def _days_since(date_str):
    try:
        d = datetime.fromisoformat(date_str)
        return (datetime.utcnow() - d).total_seconds() / 86400
    except (ValueError, TypeError):
        return 0


def compute_decayed_confidence(confidence, last_accessed):
    days = _days_since(last_accessed)
    if days <= 0:
        return confidence
    decay = math.exp(-0.693 * days / DECAY_HALF_LIFE_DAYS)
    return confidence * decay


def _node_from_row(row):
    return Node(
        id=row[0], layer=row[1], title=row[2], content=row[3],
        summary=row[4], tags=json.loads(row[5]), properties=json.loads(row[6]),
        weight=row[7], confidence=row[8], access_count=row[9],
        created=row[10], updated=row[11], last_accessed=row[12],
        supersedes=row[13],
    )


def _edge_from_row(row):
    return Edge(
        source_id=row[0], target_id=row[1], weight=row[2],
        edge_type=row[3], context=row[4], last_seen=row[5],
    )


class GraphStore:
    def __init__(self, db_path):
        self.db_path = db_path
        self.conn = None

    def open(self):
        self.conn = sqlite3.connect(self.db_path)
        # Use DELETE journal mode — WAL causes disk I/O errors on iCloud-synced dirs
        self.conn.execute("PRAGMA journal_mode=DELETE")
        self.conn.execute("PRAGMA synchronous=NORMAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.executescript(SCHEMA)
        self.conn.commit()
        return self

    def close(self):
        if self.conn:
            self.conn.close()
            self.conn = None

    # --- Node CRUD ---

    def put_node(self, node):
        now = _now()
        node.updated = now
        self.conn.execute(
            """INSERT OR REPLACE INTO nodes
               (id, layer, title, content, summary, tags, properties,
                weight, confidence, access_count, created, updated, last_accessed, supersedes)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (node.id, node.layer, node.title, node.content, node.summary,
             json.dumps(node.tags), json.dumps(node.properties),
             node.weight, node.confidence, node.access_count,
             node.created, node.updated, node.last_accessed, node.supersedes),
        )
        # Sync tags
        self.conn.execute("DELETE FROM tags WHERE node_id = ?", (node.id,))
        for tag in node.tags:
            self.conn.execute(
                "INSERT OR IGNORE INTO tags (tag, node_id) VALUES (?, ?)",
                (tag, node.id),
            )
        self.conn.commit()
        return node

    def get_node(self, node_id):
        row = self.conn.execute(
            "SELECT * FROM nodes WHERE id = ?", (node_id,)
        ).fetchone()
        return _node_from_row(row) if row else None

    def delete_node(self, node_id):
        self.conn.execute("DELETE FROM nodes WHERE id = ?", (node_id,))
        self.conn.execute("DELETE FROM edges WHERE source_id = ? OR target_id = ?",
                          (node_id, node_id))
        self.conn.execute("DELETE FROM tags WHERE node_id = ?", (node_id,))
        self.conn.commit()

    def list_nodes(self, layer=None, limit=1000):
        if layer:
            rows = self.conn.execute(
                "SELECT * FROM nodes WHERE layer = ? ORDER BY weight DESC LIMIT ?",
                (layer, limit),
            ).fetchall()
        else:
            rows = self.conn.execute(
                "SELECT * FROM nodes ORDER BY weight DESC LIMIT ?", (limit,)
            ).fetchall()
        return [_node_from_row(r) for r in rows]

    def count_nodes(self, layer=None):
        if layer:
            return self.conn.execute(
                "SELECT COUNT(*) FROM nodes WHERE layer = ?", (layer,)
            ).fetchone()[0]
        return self.conn.execute("SELECT COUNT(*) FROM nodes").fetchone()[0]

    # --- Edge CRUD ---

    def put_edge(self, edge):
        edge.last_seen = _now()
        # Upsert: increment weight if exists
        existing = self.conn.execute(
            "SELECT weight FROM edges WHERE source_id = ? AND target_id = ?",
            (edge.source_id, edge.target_id),
        ).fetchone()
        if existing:
            self.conn.execute(
                """UPDATE edges SET weight = weight + 1, edge_type = ?,
                   context = ?, last_seen = ?
                   WHERE source_id = ? AND target_id = ?""",
                (edge.edge_type, edge.context, edge.last_seen,
                 edge.source_id, edge.target_id),
            )
        else:
            self.conn.execute(
                """INSERT INTO edges (source_id, target_id, weight, edge_type, context, last_seen)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (edge.source_id, edge.target_id, edge.weight,
                 edge.edge_type, edge.context, edge.last_seen),
            )
        self.conn.commit()

    def remove_edge(self, source_id, target_id):
        self.conn.execute(
            "DELETE FROM edges WHERE source_id = ? AND target_id = ?",
            (source_id, target_id),
        )
        self.conn.commit()

    def get_forward_edges(self, node_id):
        rows = self.conn.execute(
            "SELECT * FROM edges WHERE source_id = ? ORDER BY weight DESC",
            (node_id,),
        ).fetchall()
        return [_edge_from_row(r) for r in rows]

    def get_back_edges(self, node_id):
        rows = self.conn.execute(
            "SELECT * FROM edges WHERE target_id = ? ORDER BY weight DESC",
            (node_id,),
        ).fetchall()
        return [_edge_from_row(r) for r in rows]

    def get_immediate_edges(self, node_id):
        """All edges touching this node (both directions)."""
        return self.get_forward_edges(node_id) + self.get_back_edges(node_id)

    def count_edges(self):
        return self.conn.execute("SELECT COUNT(*) FROM edges").fetchone()[0]

    # --- Graph queries ---

    def get_neighbors(self, node_id, depth=1):
        """BFS traversal returning {node_id: distance}."""
        visited = {}
        queue = [(node_id, 0)]
        while queue:
            current, dist = queue.pop(0)
            if current in visited:
                continue
            visited[current] = dist
            if dist < depth:
                for edge in self.get_forward_edges(current):
                    if edge.target_id not in visited:
                        queue.append((edge.target_id, dist + 1))
                for edge in self.get_back_edges(current):
                    if edge.source_id not in visited:
                        queue.append((edge.source_id, dist + 1))
        return visited

    def get_nodes_by_tag(self, tag):
        rows = self.conn.execute(
            """SELECT n.* FROM nodes n
               JOIN tags t ON n.id = t.node_id
               WHERE t.tag = ?
               ORDER BY n.weight DESC""",
            (tag,),
        ).fetchall()
        return [_node_from_row(r) for r in rows]

    def get_active_nodes(self, layer=None, min_confidence=None):
        min_conf = min_confidence or MIN_CONFIDENCE_ACTIVE
        if layer:
            rows = self.conn.execute(
                """SELECT * FROM nodes WHERE layer = ? AND confidence >= ?
                   ORDER BY weight DESC""",
                (layer, min_conf),
            ).fetchall()
        else:
            rows = self.conn.execute(
                "SELECT * FROM nodes WHERE confidence >= ? ORDER BY weight DESC",
                (min_conf,),
            ).fetchall()
        return [_node_from_row(r) for r in rows]

    # --- Layer management ---

    def promote_nodes(self, node_ids, to_layer="session"):
        """Move specific nodes to a new layer."""
        for nid in node_ids:
            self.conn.execute(
                "UPDATE nodes SET layer = ?, updated = ? WHERE id = ?",
                (to_layer, _now(), nid),
            )
        self.conn.commit()
        return len(node_ids)

    def clear_layer(self, layer):
        """Remove all nodes and their edges from a layer."""
        node_ids = [r[0] for r in self.conn.execute(
            "SELECT id FROM nodes WHERE layer = ?", (layer,)
        ).fetchall()]
        if node_ids:
            placeholders = ",".join("?" * len(node_ids))
            self.conn.execute(f"DELETE FROM edges WHERE source_id IN ({placeholders})", node_ids)
            self.conn.execute(f"DELETE FROM edges WHERE target_id IN ({placeholders})", node_ids)
            self.conn.execute(f"DELETE FROM tags WHERE node_id IN ({placeholders})", node_ids)
            self.conn.execute(f"DELETE FROM nodes WHERE layer = ?", (layer,))
            self.conn.commit()
        return len(node_ids)

    # --- Access & reinforcement ---

    def reinforce(self, node_ids):
        now = _now()
        for nid in node_ids:
            self.conn.execute(
                """UPDATE nodes SET
                   access_count = access_count + 1,
                   last_accessed = ?,
                   weight = weight + ?,
                   confidence = MIN(?, confidence + ?)
                   WHERE id = ?""",
                (now, REINFORCE_WEIGHT, MAX_CONFIDENCE, REINFORCE_CONFIDENCE, nid),
            )
        self.conn.commit()

    # --- Decay ---

    def apply_decay(self):
        """Apply confidence decay to all nodes. Returns stale node IDs."""
        nodes = self.list_nodes()
        stale = []
        for node in nodes:
            decayed = compute_decayed_confidence(node.confidence, node.last_accessed)
            if decayed != node.confidence:
                self.conn.execute(
                    "UPDATE nodes SET confidence = ? WHERE id = ?",
                    (decayed, node.id),
                )
            if decayed < MIN_CONFIDENCE_ACTIVE:
                stale.append(node.id)
        self.conn.commit()
        return stale

    # --- History ---

    def save_snapshot(self, node_id):
        node = self.get_node(node_id)
        if not node:
            return
        snapshot = json.dumps({
            "id": node.id, "layer": node.layer, "title": node.title,
            "content": node.content, "summary": node.summary,
            "tags": node.tags, "properties": node.properties,
            "weight": node.weight, "confidence": node.confidence,
        })
        self.conn.execute(
            "INSERT INTO history (node_id, timestamp, snapshot) VALUES (?, ?, ?)",
            (node_id, _now(), snapshot),
        )
        self.conn.commit()

    def get_history(self, node_id, limit=50):
        rows = self.conn.execute(
            """SELECT timestamp, snapshot FROM history
               WHERE node_id = ? ORDER BY timestamp DESC LIMIT ?""",
            (node_id, limit),
        ).fetchall()
        return [(r[0], json.loads(r[1])) for r in rows]

    # --- Batch ---

    def batch_put_nodes(self, nodes):
        for node in nodes:
            self.put_node(node)

    def batch_put_edges(self, edges):
        for edge in edges:
            self.put_edge(edge)

    # --- Stats ---

    def stats(self):
        try:
            return {
                "total_nodes": self.count_nodes(),
                "session_nodes": self.count_nodes("session"),
                "prompt_nodes": self.count_nodes("prompt"),
                "system_nodes": self.count_nodes("system"),
                "total_edges": self.count_edges(),
            }
        except sqlite3.OperationalError:
            return {"total_nodes": -1, "session_nodes": -1, "prompt_nodes": -1,
                    "system_nodes": -1, "total_edges": -1}
