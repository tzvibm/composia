"""FastEmbed vector store with numpy-based similarity search.

Uses SQLite for persistence (same DB as GraphStore) but does similarity
search in numpy since macOS system Python doesn't support SQLite extensions.
Fast enough for <50k nodes (~5ms search)."""

import json
import sqlite3

import numpy as np

from .config import EMBED_MODEL, EMBED_DIMS, RAG_TOP_K
from .models import Node, SimilarityResult


class VectorStore:
    def __init__(self, conn, model_name=None):
        """Takes an existing SQLite connection (shared with GraphStore)."""
        self.conn = conn
        self.model_name = model_name or EMBED_MODEL
        self._model = None
        self._cache = {}  # node_id -> numpy array (must init before _setup_table)
        self._setup_table()

    def _setup_table(self):
        """Create embeddings table in shared SQLite DB."""
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS embeddings (
                node_id TEXT PRIMARY KEY,
                embedding BLOB NOT NULL
            )
        """)
        self.conn.commit()
        # Load existing embeddings into cache
        rows = self.conn.execute("SELECT node_id, embedding FROM embeddings").fetchall()
        for node_id, blob in rows:
            self._cache[node_id] = np.frombuffer(blob, dtype=np.float32)

    @property
    def model(self):
        if self._model is None:
            from fastembed import TextEmbedding
            self._model = TextEmbedding(model_name=self.model_name)
        return self._model

    def embed_text(self, text):
        return np.array(next(self.model.embed([text])), dtype=np.float32)

    def embed_batch(self, texts):
        return [np.array(e, dtype=np.float32) for e in self.model.embed(texts)]

    def upsert_node(self, node_id, text):
        embedding = self.embed_text(text)
        self.conn.execute(
            "INSERT OR REPLACE INTO embeddings (node_id, embedding) VALUES (?, ?)",
            (node_id, embedding.tobytes()),
        )
        self.conn.commit()
        self._cache[node_id] = embedding

    def upsert_batch(self, items):
        """items = [(node_id, text), ...]"""
        if not items:
            return
        texts = [text for _, text in items]
        embeddings = self.embed_batch(texts)
        for (node_id, _), emb in zip(items, embeddings):
            self.conn.execute(
                "INSERT OR REPLACE INTO embeddings (node_id, embedding) VALUES (?, ?)",
                (node_id, emb.tobytes()),
            )
            self._cache[node_id] = emb
        self.conn.commit()

    def delete_node(self, node_id):
        self.conn.execute("DELETE FROM embeddings WHERE node_id = ?", (node_id,))
        self.conn.commit()
        self._cache.pop(node_id, None)

    def search(self, query, limit=None, layer=None):
        """Find similar nodes using cosine similarity."""
        limit = limit or RAG_TOP_K
        query_emb = self.embed_text(query)

        # Get candidate node IDs (optionally filtered by layer)
        if layer:
            rows = self.conn.execute(
                "SELECT id FROM nodes WHERE layer = ?", (layer,)
            ).fetchall()
            candidate_ids = {r[0] for r in rows}
        else:
            candidate_ids = None

        # Compute similarities
        scores = []
        for node_id, emb in self._cache.items():
            if candidate_ids is not None and node_id not in candidate_ids:
                continue
            # Cosine similarity
            sim = np.dot(query_emb, emb) / (np.linalg.norm(query_emb) * np.linalg.norm(emb) + 1e-8)
            scores.append((node_id, float(sim)))

        # Sort by similarity descending
        scores.sort(key=lambda x: x[1], reverse=True)
        scores = scores[:limit]

        # Fetch full nodes
        results = []
        for node_id, sim in scores:
            row = self.conn.execute("SELECT * FROM nodes WHERE id = ?", (node_id,)).fetchone()
            if row:
                node = Node(
                    id=row[0], layer=row[1], title=row[2], content=row[3],
                    summary=row[4], tags=json.loads(row[5]),
                    properties=json.loads(row[6]),
                    weight=row[7], confidence=row[8], access_count=row[9],
                    created=row[10], updated=row[11], last_accessed=row[12],
                    supersedes=row[13],
                )
                results.append(SimilarityResult(node=node, score=sim))
        return results

    def count(self):
        return len(self._cache)
