"""Steps 1-13: Full context engine pipeline orchestrator."""

import os
from pathlib import Path

from .models import Node, Edge
from .config import (
    DEFAULT_DB_PATH, REASON_MODEL, BUILD_MODEL,
    CONFIDENCE_THRESHOLD, MAX_TRAVERSAL_ITERATIONS,
)
from .graph_store import GraphStore
from .vector_store import VectorStore
from .decomposer import Decomposer
from .retriever import Retriever
from .resynthesizer import Resynthesizer
from .prompt_template import PromptTemplate
from .llm_client import LLMClient


class ContextPipeline:
    def __init__(
        self,
        db_path=None,
        reason_model=None,
        build_model=None,
        auto_approve=False,
        confidence_threshold=None,
        max_traversal=None,
    ):
        self.db_path = db_path or DEFAULT_DB_PATH
        self.auto_approve = auto_approve
        self.confidence_threshold = confidence_threshold or CONFIDENCE_THRESHOLD
        self.max_traversal = max_traversal or MAX_TRAVERSAL_ITERATIONS

        # Ensure directory exists
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)

        # Initialize components
        self.graph = GraphStore(self.db_path).open()
        self.vectors = VectorStore(self.graph.conn)

        build_llm = LLMClient(model=build_model or BUILD_MODEL)
        reason_llm = LLMClient(model=reason_model or REASON_MODEL)

        self.decomposer = Decomposer(llm=build_llm)
        self.retriever = Retriever(self.graph, self.vectors, llm=build_llm)
        self.resynthesizer = Resynthesizer(self.graph, llm=build_llm)
        self.template = PromptTemplate(self.graph)
        self.reason_llm = reason_llm

    def turn(self, user_input):
        """Full 13-step pipeline: user input -> LLM response."""
        # Clear previous prompt layer
        self.graph.clear_layer("prompt")

        # Steps 1-3: Decompose input into prompt graph
        nodes, edges = self.step_1_3_decompose(user_input, source="user")
        if not nodes:
            # Fallback: treat entire input as a single question node
            from .models import Node
            nodes = [Node(
                id="user-query",
                layer="prompt",
                title=user_input[:60],
                content=user_input,
                summary=user_input,
                tags=["question"],
            )]
            edges = []

        # Store in graph and vector index
        self.graph.batch_put_nodes(nodes)
        self.graph.batch_put_edges(edges)

        # Step 4: Index prompt nodes in vector store
        self.step_4_index(nodes)

        # Step 5: Find similar session nodes
        similar = self.step_5_search(nodes)

        # Step 6: Build tuples
        tuples = self.step_6_build_tuples(nodes, similar)

        # Step 7: Confidence-based traversal
        if tuples:
            tuples = self.step_7_traverse(tuples)

        # Step 8: Propose graph changes
        changes = self.step_8_resynthesize(tuples, nodes)

        # Step 9: Apply changes (with optional approval)
        self.step_9_approve(changes)

        # Build similarity map for template rendering
        similar_map = {}
        for t in tuples:
            pid = t.prompt_node.id
            if pid not in similar_map:
                similar_map[pid] = []
            similar_map[pid].append((t.session_node.id, t.similarity))

        # Steps 10-11: Render prompt
        system_prompt = self.template.render_full(similar_map)

        # Step 12: Send to reasoning LLM
        response = self.step_12_send(system_prompt, user_input)

        # Step 13: Process response (decompose into session graph)
        self.step_13_process_response(response)

        return response

    # --- Individual steps ---

    def step_1_3_decompose(self, text, source="user"):
        return self.decomposer.build_prompt_graph(text, source=source)

    def step_4_index(self, nodes):
        self.retriever.index_prompt_graph(nodes)

    def step_5_search(self, nodes):
        return self.retriever.find_similar(nodes)

    def step_6_build_tuples(self, prompt_nodes, similar):
        return self.retriever.build_tuples(prompt_nodes, similar)

    def step_7_traverse(self, tuples):
        return self.retriever.traverse_with_confidence(
            tuples,
            threshold=self.confidence_threshold,
            max_iter=self.max_traversal,
        )

    def step_8_resynthesize(self, tuples, prompt_nodes=None):
        if tuples:
            return self.resynthesizer.propose_changes(tuples)
        # No similar nodes found — promote all prompt nodes
        prompt_ids = [n.id for n in (prompt_nodes or [])]
        from .models import ChangeSet
        return ChangeSet(
            promote_nodes=prompt_ids,
            summary="No existing knowledge. All new input added to session.",
        )

    def step_9_approve(self, changes):
        return self.resynthesizer.apply_changes(changes, auto_approve=self.auto_approve)

    def step_12_send(self, system_prompt, user_input):
        return self.reason_llm.call(
            user_input,
            system=system_prompt,
            max_tokens=4096,
            temperature=0,
        )

    def step_13_process_response(self, response):
        """Decompose LLM response and add to session graph."""
        nodes, edges = self.decomposer.build_prompt_graph(response, source="assistant")
        if nodes:
            # Directly promote response nodes to session (no approval needed)
            for node in nodes:
                node.layer = "session"
            self.graph.batch_put_nodes(nodes)
            self.graph.batch_put_edges(edges)
            # Index in vector store
            items = [(n.id, f"{n.title} {n.summary}") for n in nodes]
            self.vectors.upsert_batch(items)

    def ingest(self, text, source="context"):
        """Ingest text directly into session graph (for benchmarks)."""
        nodes, edges = self.decomposer.build_prompt_graph(text, source=source)
        for node in nodes:
            node.layer = "session"
        self.graph.batch_put_nodes(nodes)
        self.graph.batch_put_edges(edges)
        items = [(n.id, f"{n.title} {n.summary}") for n in nodes]
        self.vectors.upsert_batch(items)
        return len(nodes)

    def answer(self, question):
        """Answer a question from session graph (for benchmarks)."""
        # Decompose question
        nodes, edges = self.decomposer.build_prompt_graph(question, source="question")
        if not nodes:
            nodes = [Node(id="q", layer="prompt", title=question,
                         content=question, summary=question, tags=["question"])]

        self.graph.batch_put_nodes(nodes)
        self.retriever.index_prompt_graph(nodes)

        # Find similar
        similar = self.retriever.find_similar(nodes)
        tuples = self.retriever.build_tuples(nodes, similar)

        # Build similarity map
        similar_map = {}
        for t in tuples:
            pid = t.prompt_node.id
            if pid not in similar_map:
                similar_map[pid] = []
            similar_map[pid].append((t.session_node.id, t.similarity))

        # Reinforce accessed session nodes
        accessed = list({t.session_node.id for t in tuples})
        if accessed:
            self.graph.reinforce(accessed)

        # Render and answer
        system_prompt = self.template.render_full(similar_map)

        response = self.reason_llm.call(
            question,
            system=system_prompt,
            max_tokens=50,
            temperature=0,
        )

        # Clean up prompt layer
        self.graph.clear_layer("prompt")

        return response

    def stats(self):
        return self.graph.stats()

    def close(self):
        self.graph.close()


def main():
    """Interactive REPL."""
    import sys
    db_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_DB_PATH

    pipeline = ContextPipeline(db_path=db_path)
    print(f"Composia Context Engine v2")
    print(f"DB: {db_path} | {pipeline.stats()}")
    print(f"Commands: quit, stats, graph")
    print()

    while True:
        try:
            user_input = input("You: ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nDone.")
            break

        if not user_input:
            continue
        if user_input == "quit":
            break
        if user_input == "stats":
            print(pipeline.stats())
            continue
        if user_input == "graph":
            nodes = pipeline.graph.list_nodes(limit=20)
            for n in nodes:
                print(f"  @{n.id} [{n.layer}] [{', '.join(n.tags)}]: {n.summary}")
            continue

        response = pipeline.turn(user_input)
        print(f"\nAssistant: {response}\n")

    pipeline.close()


if __name__ == "__main__":
    main()
