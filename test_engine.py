#!/usr/bin/env python3
"""
Comprehensive test suite for the context engine.
Tests every step of the pipeline, not just happy paths.
Run: python3 test_engine.py
"""

import os
import sys
import json
import shutil
import traceback

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), '.env'))

from context_engine.models import Node, Edge, ChangeSet
from context_engine.config import *
from context_engine.graph_store import GraphStore, compute_decayed_confidence
from context_engine.vector_store import VectorStore
from context_engine.llm_client import LLMClient
from context_engine.decomposer import Decomposer
from context_engine.retriever import Retriever
from context_engine.resynthesizer import Resynthesizer
from context_engine.prompt_template import PromptTemplate
from context_engine.pipeline import ContextPipeline

PASS = 0
FAIL = 0
ERRORS = []

def test(name, fn):
    global PASS, FAIL
    try:
        fn()
        PASS += 1
        print(f"  PASS: {name}")
    except Exception as e:
        FAIL += 1
        ERRORS.append((name, str(e)))
        print(f"  FAIL: {name} — {e}")
        traceback.print_exc()


def fresh_db():
    path = f"/tmp/composia-test-{os.getpid()}/test.db"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    return path


# ===== PHASE 1: Graph Store =====

def test_graph_store():
    print("\n=== GRAPH STORE ===")
    db = fresh_db()
    g = GraphStore(db).open()

    def crud_nodes():
        n = Node(id="n1", layer="session", title="T1", content="C1", summary="S1", tags=["fact"])
        g.put_node(n)
        got = g.get_node("n1")
        assert got is not None, "get_node returned None"
        assert got.title == "T1", f"title mismatch: {got.title}"
        assert got.tags == ["fact"], f"tags mismatch: {got.tags}"
        assert g.count_nodes() == 1
        assert g.count_nodes("session") == 1
        assert g.count_nodes("prompt") == 0
    test("CRUD nodes", crud_nodes)

    def crud_edges():
        g.put_node(Node(id="n2", layer="session", title="T2", content="C2", summary="S2"))
        g.put_edge(Edge(source_id="n1", target_id="n2", edge_type="relates_to"))
        assert g.count_edges() == 1
        fwd = g.get_forward_edges("n1")
        assert len(fwd) == 1, f"forward edges: {len(fwd)}"
        assert fwd[0].target_id == "n2"
        back = g.get_back_edges("n2")
        assert len(back) == 1
        assert back[0].source_id == "n1"
    test("CRUD edges", crud_edges)

    def edge_weight_increments():
        g.put_edge(Edge(source_id="n1", target_id="n2"))
        e = g.get_forward_edges("n1")[0]
        assert e.weight >= 2, f"edge weight should increment: {e.weight}"
    test("Edge weight increments on re-add", edge_weight_increments)

    def tags_index():
        tagged = g.get_nodes_by_tag("fact")
        assert len(tagged) == 1, f"expected 1 tagged node, got {len(tagged)}"
        assert tagged[0].id == "n1"
    test("Tags index query", tags_index)

    def neighbors_bfs():
        neighbors = g.get_neighbors("n1", depth=1)
        assert "n2" in neighbors, f"n2 not in neighbors: {neighbors}"
    test("BFS neighbors", neighbors_bfs)

    def reinforce():
        g.reinforce(["n1"])
        n = g.get_node("n1")
        assert n.access_count == 1, f"access_count: {n.access_count}"
        assert n.weight > 1.0, f"weight: {n.weight}"
    test("Reinforce increases weight/access_count", reinforce)

    def layer_operations():
        g.put_node(Node(id="p1", layer="prompt", title="P", content="P", summary="P"))
        g.put_node(Node(id="p2", layer="prompt", title="P2", content="P2", summary="P2"))
        assert g.count_nodes("prompt") == 2
        g.promote_nodes(["p1"], "session")
        assert g.get_node("p1").layer == "session"
        cleared = g.clear_layer("prompt")
        assert cleared == 1, f"cleared: {cleared}"
        assert g.count_nodes("prompt") == 0
    test("Promote and clear layer", layer_operations)

    def delete_cascades():
        g.put_node(Node(id="d1", layer="session", title="D", content="D", summary="D", tags=["delete-me"]))
        g.put_edge(Edge(source_id="d1", target_id="n1"))
        g.delete_node("d1")
        assert g.get_node("d1") is None
        assert len(g.get_back_edges("n1")) == 0 or all(e.source_id != "d1" for e in g.get_back_edges("n1"))
        assert len(g.get_nodes_by_tag("delete-me")) == 0
    test("Delete node cascades to edges and tags", delete_cascades)

    def decay():
        old = Node(id="old1", layer="session", title="Old", content="Old", summary="Old",
                   confidence=1.0, last_accessed="2020-01-01T00:00:00")
        g.put_node(old)
        decayed = compute_decayed_confidence(1.0, "2020-01-01T00:00:00")
        assert decayed < 0.01, f"decay should be near 0 for old node: {decayed}"
    test("Decay computation", decay)

    def history():
        g.save_snapshot("n1")
        hist = g.get_history("n1")
        assert len(hist) >= 1, f"history entries: {len(hist)}"
    test("History snapshots", history)

    g.close()


# ===== PHASE 2: Vector Store =====

def test_vector_store():
    print("\n=== VECTOR STORE ===")
    db = fresh_db()
    g = GraphStore(db).open()
    v = VectorStore(g.conn)

    def embed_and_search():
        g.put_node(Node(id="jwt", layer="session", title="JWT", content="JWT auth", summary="JWT for auth", tags=["fact"]))
        g.put_node(Node(id="pg", layer="session", title="Postgres", content="PostgreSQL", summary="Using Postgres", tags=["fact"]))
        v.upsert_node("jwt", "JWT authentication tokens")
        v.upsert_node("pg", "PostgreSQL database")
        results = v.search("auth tokens", limit=5, layer="session")
        assert len(results) > 0, "no search results"
        assert results[0].node.id == "jwt", f"expected jwt first, got {results[0].node.id}"
        assert results[0].score > results[1].score if len(results) > 1 else True
    test("Embed and search returns ranked results", embed_and_search)

    def batch_upsert():
        items = [("a", "alpha"), ("b", "beta"), ("c", "gamma")]
        for nid, _ in items:
            g.put_node(Node(id=nid, layer="session", title=nid, content=nid, summary=nid))
        v.upsert_batch(items)
        assert v.count() >= 5  # jwt, pg, a, b, c
    test("Batch upsert", batch_upsert)

    def layer_filter():
        g.put_node(Node(id="prompt-node", layer="prompt", title="PN", content="PN", summary="PN"))
        v.upsert_node("prompt-node", "prompt node test")
        results = v.search("prompt", limit=5, layer="session")
        ids = [r.node.id for r in results]
        assert "prompt-node" not in ids, "prompt node should not appear in session-filtered search"
    test("Layer filter excludes other layers", layer_filter)

    g.close()


# ===== PHASE 3: Decomposer =====

def test_decomposer():
    print("\n=== DECOMPOSER (LLM) ===")
    llm = LLMClient(model=BUILD_MODEL)
    decomposer = Decomposer(llm=llm)

    def decompose_factual():
        nodes = decomposer.decompose_to_nodes(
            "We chose FastAPI for the backend because it has great WebSocket support. "
            "The database will be PostgreSQL with row-level locking.",
            source="user"
        )
        assert len(nodes) >= 2, f"expected >=2 nodes, got {len(nodes)}"
        all_content = " ".join(n.content.lower() + " " + n.summary.lower() for n in nodes)
        assert "fastapi" in all_content, f"'fastapi' not preserved in nodes"
        assert "postgresql" in all_content or "postgres" in all_content, f"'postgresql' not in nodes"
        for n in nodes:
            assert n.layer == "prompt", f"node layer should be prompt: {n.layer}"
            assert len(n.tags) > 0, f"node should have tags: {n.id}"
    test("Decomposes factual text into tagged nodes", decompose_factual)

    def decompose_preserves_exact_words():
        nodes = decomposer.decompose_to_nodes(
            "The API rate limit is 500 requests per minute per user.",
            source="user"
        )
        all_text = " ".join(n.content + " " + n.summary for n in nodes)
        assert "500" in all_text, f"number '500' not preserved: {all_text[:200]}"
    test("Preserves exact numbers/details", decompose_preserves_exact_words)

    def decompose_greeting():
        nodes = decomposer.decompose_to_nodes("Hello, how are you?", source="user")
        assert len(nodes) >= 1, f"greeting should produce at least 1 node, got {len(nodes)}"
    test("Handles greeting (non-factual input)", decompose_greeting)

    def decompose_empty():
        nodes = decomposer.decompose_to_nodes("", source="user")
        assert len(nodes) == 0, f"empty input should produce 0 nodes, got {len(nodes)}"
    test("Empty input returns no nodes", decompose_empty)

    def generate_edges():
        nodes = decomposer.decompose_to_nodes(
            "FastAPI is the backend framework. PostgreSQL is the database. "
            "FastAPI connects to PostgreSQL via SQLAlchemy.",
            source="user"
        )
        edges = decomposer.generate_edges(nodes)
        assert len(edges) >= 1, f"expected >=1 edge, got {len(edges)}"
        node_ids = {n.id for n in nodes}
        for e in edges:
            assert e.source_id in node_ids, f"edge source {e.source_id} not in nodes"
            assert e.target_id in node_ids, f"edge target {e.target_id} not in nodes"
            assert e.edge_type != "", f"edge should have a type"
    test("Generates typed edges between nodes", generate_edges)

    def build_prompt_graph():
        nodes, edges = decomposer.build_prompt_graph(
            "Redis will handle real-time pub/sub. We need it for WebSocket fanout.",
            source="user"
        )
        assert len(nodes) >= 1, f"expected nodes, got {len(nodes)}"
        # edges may be 0 if only 1 node, that's fine
    test("build_prompt_graph returns nodes + edges", build_prompt_graph)


# ===== PHASE 4: Prompt Template =====

def test_prompt_template():
    print("\n=== PROMPT TEMPLATE ===")
    db = fresh_db()
    g = GraphStore(db).open()
    tmpl = PromptTemplate(g)

    def empty_graph():
        rendered = tmpl.render_full()
        assert isinstance(rendered, str), "render should return string"
        # Empty graph should still render system instructions
        assert len(rendered) > 0
    test("Empty graph renders without error", empty_graph)

    def with_nodes():
        g.put_node(Node(id="n1", layer="session", title="FastAPI", content="Backend choice", summary="FastAPI for backend", tags=["decision"]))
        g.put_node(Node(id="n2", layer="session", title="Postgres", content="Database choice", summary="PostgreSQL DB", tags=["decision"]))
        g.put_edge(Edge(source_id="n1", target_id="n2", edge_type="connects_to"))
        rendered = tmpl.render_session()
        assert "@n1" in rendered, "node ID not in rendered template"
        assert "@n2" in rendered
        assert "FastAPI" in rendered
        assert "decision" in rendered
    test("Session graph renders with nodes and edges", with_nodes)

    def prompt_with_similarity():
        g.put_node(Node(id="p1", layer="prompt", title="Query", content="Q", summary="Question", tags=["question"]))
        rendered = tmpl.render_prompt(similar_map={"p1": [("n1", 0.85)]})
        assert "@p1" in rendered
        assert "0.85" in rendered
        assert "SIMILAR" in rendered
    test("Prompt graph renders with similarity scores", prompt_with_similarity)

    def full_render():
        rendered = tmpl.render_full(similar_map={"p1": [("n1", 0.85)]})
        assert "SESSION CONTEXT" in rendered
        assert "CURRENT INPUT" in rendered
    test("Full render includes both sections", full_render)

    g.close()


# ===== PHASE 5: Full Pipeline =====

def test_pipeline():
    print("\n=== FULL PIPELINE (LLM) ===")
    db = fresh_db()
    p = ContextPipeline(db_path=db, auto_approve=True)

    def turn_1_creates_nodes():
        response = p.turn("I want to build a notes app for 100k users with real-time collaboration.")
        stats = p.stats()
        assert stats["session_nodes"] > 0, f"no session nodes after turn 1: {stats}"
        assert stats["total_edges"] >= 0  # may have edges
        assert len(response) > 10, f"response too short: {response}"
    test("Turn 1: creates session nodes from input", turn_1_creates_nodes)

    def turn_2_finds_context():
        response = p.turn("For the backend, I'm choosing FastAPI because I know Python.")
        stats = p.stats()
        assert stats["session_nodes"] > 5, f"graph should grow: {stats}"
    test("Turn 2: grows graph with new context", turn_2_finds_context)

    def turn_3_question_uses_context():
        response = p.turn("What tech stack have we discussed?")
        assert len(response) > 20, f"response too short: {response}"
        # Response should reference prior context
        resp_lower = response.lower()
        has_context = ("notes" in resp_lower or "fastapi" in resp_lower or
                       "backend" in resp_lower or "100k" in resp_lower)
        assert has_context, f"response doesn't reference prior context: {response[:200]}"
    test("Turn 3: question retrieves prior context", turn_3_question_uses_context)

    def graph_is_connected():
        nodes = p.graph.list_nodes(layer="session", limit=100)
        has_edges = False
        for n in nodes:
            edges = p.graph.get_forward_edges(n.id)
            if edges:
                has_edges = True
                break
        assert has_edges, "session graph should have edges connecting nodes"
    test("Graph has edges connecting session nodes", graph_is_connected)

    def graph_command_works():
        nodes = p.graph.list_nodes(limit=10)
        assert len(nodes) > 0
        for n in nodes:
            assert n.id != ""
            assert n.summary != ""
    test("Graph listing works", graph_command_works)

    def dump_renders():
        rendered = p.template.render_full()
        assert len(rendered) > 100, f"rendered template too short: {len(rendered)}"
        assert "SESSION CONTEXT" in rendered
    test("Dump/render produces valid template", dump_renders)

    p.close()


# ===== PHASE 6: Edge Cases =====

def test_edge_cases():
    print("\n=== EDGE CASES ===")
    db = fresh_db()
    p = ContextPipeline(db_path=db, auto_approve=True)

    def empty_input():
        # Pipeline should handle gracefully
        nodes, edges = p.step_1_3_decompose("", source="user")
        assert len(nodes) == 0
    test("Empty string produces no nodes", empty_input)

    def very_long_input():
        long_text = "This is a fact about architecture. " * 100
        nodes, edges = p.step_1_3_decompose(long_text, source="user")
        assert len(nodes) >= 1, "long input should produce at least 1 node"
    test("Very long input decomposes", very_long_input)

    def special_characters():
        text = 'He said "don\'t use MongoDB!" — that\'s a $100 mistake @scale.'
        nodes, edges = p.step_1_3_decompose(text, source="user")
        assert len(nodes) >= 1
    test("Special characters handled", special_characters)

    def concurrent_layers():
        p.graph.put_node(Node(id="s1", layer="session", title="S", content="S", summary="S"))
        p.graph.put_node(Node(id="p1", layer="prompt", title="P", content="P", summary="P"))
        assert p.graph.count_nodes("session") >= 1
        assert p.graph.count_nodes("prompt") >= 1
        p.graph.clear_layer("prompt")
        assert p.graph.count_nodes("prompt") == 0
        assert p.graph.count_nodes("session") >= 1  # session untouched
    test("Clear prompt doesn't affect session", concurrent_layers)

    p.close()


# ===== RUN ALL =====

def main():
    print("=" * 70)
    print("COMPOSIA CONTEXT ENGINE v2 — COMPREHENSIVE TEST SUITE")
    print("=" * 70)

    test_graph_store()
    test_vector_store()
    test_decomposer()
    test_prompt_template()
    test_pipeline()
    test_edge_cases()

    print("\n" + "=" * 70)
    print(f"RESULTS: {PASS} passed, {FAIL} failed")
    if ERRORS:
        print("\nFAILURES:")
        for name, err in ERRORS:
            print(f"  {name}: {err}")
    print("=" * 70)

    # Cleanup
    shutil.rmtree(f"/tmp/composia-test-{os.getpid()}", ignore_errors=True)

    sys.exit(1 if FAIL > 0 else 0)


if __name__ == "__main__":
    main()
