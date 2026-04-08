"""Steps 4-7: RAG search and confidence-based traversal."""

from .models import Node, Edge, SimilarityResult, TraversalTuple
from .graph_store import GraphStore
from .vector_store import VectorStore
from .llm_client import LLMClient
from .config import (
    BUILD_MODEL, RAG_TOP_K, CONFIDENCE_THRESHOLD,
    MAX_TRAVERSAL_ITERATIONS,
)


TRAVERSAL_PROMPT = """Given these pairs of (new input, existing knowledge) with similarity scores, rate your confidence that you have enough context.

Pairs:
{tuples_formatted}

Rate your confidence (0.0-1.0) that the retrieved context is sufficient to fully understand the new input nodes.
If confidence < {threshold}, list node IDs whose edges should be followed for more context.

Return JSON: {{"confidence": 0.X, "traverse": ["node-id-1", "node-id-2"]}}"""


class Retriever:
    def __init__(self, graph, vectors, llm=None):
        self.graph = graph
        self.vectors = vectors
        self.llm = llm or LLMClient(model=BUILD_MODEL)

    def index_prompt_graph(self, nodes):
        """Step 4: Embed prompt nodes in vector store."""
        items = [(n.id, f"{n.title} {n.summary}") for n in nodes]
        self.vectors.upsert_batch(items)

    def find_similar(self, prompt_nodes, top_k=None):
        """Step 5: For each prompt node, find similar session nodes."""
        top_k = top_k or RAG_TOP_K
        all_results = []
        seen = set()
        for pn in prompt_nodes:
            query = f"{pn.title} {pn.summary}"
            results = self.vectors.search(query, limit=top_k, layer="session")
            for r in results:
                if r.node.id not in seen:
                    seen.add(r.node.id)
                    all_results.append(r)
        return all_results

    def build_tuples(self, prompt_nodes, similar_results):
        """Step 6: Pair prompt nodes with session nodes including edges."""
        tuples = []
        for pn in prompt_nodes:
            prompt_edges = self.graph.get_immediate_edges(pn.id)
            # Find best matching session nodes for this prompt node
            pn_query = f"{pn.title} {pn.summary}"
            pn_results = self.vectors.search(pn_query, limit=5, layer="session")
            for sr in pn_results:
                session_edges = self.graph.get_immediate_edges(sr.node.id)
                tuples.append(TraversalTuple(
                    prompt_node=pn,
                    session_node=sr.node,
                    similarity=sr.score,
                    prompt_edges=prompt_edges,
                    session_edges=session_edges,
                ))
        return tuples

    def traverse_with_confidence(self, tuples, threshold=None, max_iter=None):
        """Step 7: Confidence-based traversal loop."""
        threshold = threshold or CONFIDENCE_THRESHOLD
        max_iter = max_iter or MAX_TRAVERSAL_ITERATIONS

        if not tuples:
            return tuples

        for iteration in range(max_iter):
            # Format tuples for LLM
            lines = []
            for t in tuples:
                lines.append(
                    f"NEW: @{t.prompt_node.id} [{', '.join(t.prompt_node.tags)}]: "
                    f"{t.prompt_node.summary}\n"
                    f"  EXISTING: @{t.session_node.id} [{', '.join(t.session_node.tags)}]: "
                    f"{t.session_node.summary}\n"
                    f"  Similarity: {t.similarity:.2f}\n"
                    f"  Session edges: {', '.join(f'→@{e.target_id}' for e in t.session_edges[:5])}"
                )

            try:
                result = self.llm.call_json(
                    TRAVERSAL_PROMPT.format(
                        tuples_formatted="\n".join(lines),
                        threshold=threshold,
                    )
                )
            except (ValueError, Exception):
                break

            confidence = result.get("confidence", 1.0)
            if confidence >= threshold:
                break

            # Follow suggested edges
            traverse_ids = result.get("traverse", [])
            if not traverse_ids:
                break

            for nid in traverse_ids:
                neighbors = self.graph.get_neighbors(nid, depth=1)
                for neighbor_id in neighbors:
                    if neighbor_id == nid:
                        continue
                    neighbor = self.graph.get_node(neighbor_id)
                    if neighbor and neighbor.layer == "session":
                        # Add new tuple with the first prompt node as reference
                        session_edges = self.graph.get_immediate_edges(neighbor_id)
                        tuples.append(TraversalTuple(
                            prompt_node=tuples[0].prompt_node,
                            session_node=neighbor,
                            similarity=0.0,  # found via traversal, not similarity
                            prompt_edges=[],
                            session_edges=session_edges,
                        ))

        return tuples
