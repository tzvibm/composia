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
        changes = self.step_8_resynthesize(tuples, prompt_nodes=nodes)

        # Step 9: Apply changes
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

        # Step 13: Process response (decompose + auto-approve for non-verbose)
        prompt_ids = [n.id for n in nodes]
        resp_nodes, resp_edges = self.step_13_process_response(response)
        if resp_nodes:
            self.approve_response_graph(resp_nodes, prompt_node_ids=prompt_ids)
        self.graph.clear_layer("prompt")

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
        return self.resynthesizer.propose_changes(
            tuples, prompt_nodes=prompt_nodes,
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
        """Decompose LLM response into response graph, return for approval."""
        nodes, edges = self.decomposer.build_prompt_graph(response, source="assistant")
        if nodes:
            # Store as 'prompt' layer (will be promoted on approval)
            self.graph.batch_put_nodes(nodes)
            self.graph.batch_put_edges(edges)
            items = [(n.id, f"{n.title} {n.summary}") for n in nodes]
            self.vectors.upsert_batch(items)
        return nodes, edges

    def approve_response_graph(self, resp_nodes, prompt_node_ids=None):
        """Promote approved response nodes to session and link to prompt nodes."""
        if not resp_nodes:
            return
        resp_ids = [n.id for n in resp_nodes]
        self.graph.promote_nodes(resp_ids, to_layer="session")

        # Auto-create 'answers' edges from response nodes to the prompt nodes
        # that triggered them (now promoted to session)
        if prompt_node_ids:
            from .models import Edge as EdgeModel
            for resp_node in resp_nodes:
                for prompt_id in prompt_node_ids:
                    if self.graph.get_node(prompt_id):  # still exists in session
                        self.graph.put_edge(EdgeModel(
                            source_id=resp_node.id,
                            target_id=prompt_id,
                            edge_type="answers",
                            context="Response to user input",
                        ))

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


    def turn_verbose(self, user_input):
        """Full pipeline with step-by-step output."""
        self.graph.clear_layer("prompt")

        print(f"\n  [Steps 1-3] Decomposing...")
        nodes, edges = self.step_1_3_decompose(user_input, source="user")
        if not nodes:
            from .models import Node
            nodes = [Node(id="user-query", layer="prompt", title=user_input[:60],
                         content=user_input, summary=user_input, tags=["question"])]
            edges = []

        self.graph.batch_put_nodes(nodes)
        self.graph.batch_put_edges(edges)
        self.step_4_index(nodes)

        print(f"  Prompt graph: {len(nodes)} nodes, {len(edges)} edges")
        for n in nodes:
            print(f"    @{n.id} [{', '.join(n.tags)}]: {n.summary[:70]}")
        for e in edges[:5]:
            print(f"    @{e.source_id} --{e.edge_type}--> @{e.target_id}")

        print(f"\n  [Steps 5-7] RAG + traversal...")
        similar = self.step_5_search(nodes)
        tuples = self.step_6_build_tuples(nodes, similar)
        if tuples:
            print(f"  Found {len(tuples)} matches:")
            for t in tuples[:5]:
                print(f"    @{t.prompt_node.id} <-> @{t.session_node.id} (sim={t.similarity:.2f})")
            tuples = self.step_7_traverse(tuples)
        else:
            print(f"  No similar session nodes found")

        print(f"\n  [Step 8] Proposing graph changes...")
        changes = self.step_8_resynthesize(tuples, prompt_nodes=nodes)
        print(f"\n  Proposed changes:")
        print(f"    {changes.summary}")
        if changes.resynthesize: print(f"    Resynthesize: {len(changes.resynthesize)} nodes")
        if changes.correct: print(f"    Correct: {len(changes.correct)} nodes")
        if changes.add_content: print(f"    Add content: {len(changes.add_content)} nodes")
        if changes.delete: print(f"    Delete: {changes.delete}")
        if changes.new_edges: print(f"    New edges: {len(changes.new_edges)}")
        if changes.remove_edges: print(f"    Remove edges: {len(changes.remove_edges)}")
        if changes.promote_nodes: print(f"    Promote: {len(changes.promote_nodes)} prompt → session")

        try:
            approval = input("  Approve? [Y/n]: ").strip().lower()
        except EOFError:
            approval = "y"
        if approval == "n":
            print("  Changes rejected.")
            self.graph.clear_layer("prompt")
            return "Changes rejected. Send another message to try again."
        self.resynthesizer.apply_changes(changes, auto_approve=True)

        similar_map = {}
        for t in tuples:
            pid = t.prompt_node.id
            if pid not in similar_map:
                similar_map[pid] = []
            similar_map[pid].append((t.session_node.id, t.similarity))

        print(f"\n  [Steps 10-12] Rendering + reasoning...")
        system_prompt = self.template.render_full(similar_map)
        print(f"  System prompt: {len(system_prompt)} chars")

        response = self.step_12_send(system_prompt, user_input)

        print(f"\n  [Step 13] Decomposing response into response graph...")
        resp_nodes, resp_edges = self.step_13_process_response(response)

        if resp_nodes:
            print(f"  Response graph: {len(resp_nodes)} nodes, {len(resp_edges)} edges")
            for n in resp_nodes[:5]:
                print(f"    @{n.id} [{', '.join(n.tags[:2])}]: {n.summary[:60]}")
            if len(resp_nodes) > 5:
                print(f"    ... and {len(resp_nodes) - 5} more")

            try:
                approval = input("  Add response to session graph? [Y/n]: ").strip().lower()
            except EOFError:
                approval = "y"
            if approval != "n":
                prompt_ids = [n.id for n in nodes]
                self.approve_response_graph(resp_nodes, prompt_node_ids=prompt_ids)
                print(f"  Response graph merged into session.")
            else:
                # Delete unapproved response nodes
                for n in resp_nodes:
                    self.graph.delete_node(n.id)
                print(f"  Response graph discarded.")

        self.graph.clear_layer("prompt")

        stats = self.stats()
        print(f"  Graph: {stats['session_nodes']} session nodes, {stats['total_edges']} edges")

        # Show context size
        system_prompt_tokens = len(system_prompt) // 4  # rough estimate
        print(f"  Context size: ~{system_prompt_tokens:,} tokens ({len(system_prompt):,} chars)")

        # Show 5W1H gaps — only critical questions (confidence >= 0.8)
        completeness = changes.properties.get("completeness", [])
        critical_questions = []
        for c in completeness:
            for q in c.get("missing", []):
                if isinstance(q, dict) and q.get("confidence", 0) >= 0.8:
                    critical_questions.append((c.get("node_id", "?"), q))
                elif isinstance(q, str):
                    # Legacy format without confidence — skip low-value
                    pass

        if critical_questions:
            print(f"\n  Critical unanswered questions:")
            for node_id, q in critical_questions:
                qtext = q["question"] if isinstance(q, dict) else q
                conf = q.get("confidence", "?") if isinstance(q, dict) else "?"
                print(f"    @{node_id}: {qtext} (confidence: {conf})")

            # Add top questions to graph as question nodes
            for node_id, q in critical_questions[:3]:  # max 3
                qtext = q["question"] if isinstance(q, dict) else q
                dim = q.get("dimension", "unknown") if isinstance(q, dict) else "unknown"
                q_node = Node(
                    id=f"5w1h-{node_id}-{dim}",
                    layer="session",
                    title=f"Unanswered: {qtext[:50]}",
                    content=qtext,
                    summary=qtext,
                    tags=["question", "5w1h", dim],
                )
                self.graph.put_node(q_node)
                # Link question to the node it's about
                from .models import Edge as EdgeModel
                self.graph.put_edge(EdgeModel(
                    source_id=f"5w1h-{node_id}-{dim}",
                    target_id=node_id,
                    edge_type="questions",
                    context=f"5W1H gap: {dim}",
                ))

        return response


def main():
    """Interactive REPL with verbose pipeline output."""
    import sys
    db_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_DB_PATH

    pipeline = ContextPipeline(db_path=db_path, auto_approve=True)
    print(f"Composia Context Engine v2")
    print(f"DB: {db_path} | {pipeline.stats()}")
    print(f"Commands: quit, stats, graph, dump")
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
            nodes = pipeline.graph.list_nodes(limit=30)
            for n in nodes:
                edges_out = pipeline.graph.get_forward_edges(n.id)
                edge_str = " -> " + ", ".join(f"@{e.target_id}" for e in edges_out[:3]) if edges_out else ""
                print(f"  @{n.id} [{n.layer}] [{', '.join(n.tags[:3])}] w={n.weight:.1f}: {n.summary[:50]}{edge_str}")
            continue
        if user_input == "dump":
            system_prompt = pipeline.template.render_full()
            print(f"\n--- SYSTEM PROMPT ({len(system_prompt)} chars) ---")
            print(system_prompt[:3000])
            if len(system_prompt) > 3000:
                print(f"\n... ({len(system_prompt) - 3000} more chars)")
            print("--- END ---\n")
            continue

        response = pipeline.turn_verbose(user_input)
        print(f"\nAssistant: {response}\n")

    pipeline.close()


if __name__ == "__main__":
    main()
