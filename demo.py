#!/usr/bin/env python3
"""
Demo: Simulate a user building a notes app for 100k users.

Runs the real 13-step pipeline with pre-written prompts that show
graph construction, RAG retrieval, and context assembly in action.
"""

import os
import sys
import shutil
import time

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), '.env'))

from context_engine.pipeline import ContextPipeline

DB_PATH = "/tmp/composia-demo/context.db"

DEMO_PROMPTS = [
    "I want to build a notes app that can handle 100k users. It needs to be fast, support real-time collaboration, and have full-text search. I'm thinking about the tech stack.",

    "For the backend, I'm deciding between Node.js with Express and Python with FastAPI. The app needs WebSocket support for real-time editing. I'm leaning toward FastAPI because I know Python better.",

    "For the database, I need something that handles concurrent writes well since multiple users might edit the same note. I'm considering PostgreSQL with row-level locking vs CRDTs with a simpler store.",

    "Actually, let's go with PostgreSQL for structured data and Redis for the real-time collaboration layer. Redis pub/sub can handle the WebSocket fanout. We'll use CRDTs only for the conflict resolution within each note.",

    "For search, I want full-text search across all notes. Thinking about PostgreSQL's built-in tsvector vs a dedicated search engine like Meilisearch. At 100k users with maybe 10 million notes, what would you recommend?",

    "Let me summarize the architecture decisions we've made so far. Can you give me a complete overview of the tech stack and why we chose each component?",
]


def print_header(text, char="="):
    width = 70
    print(f"\n{char * width}")
    print(f"  {text}")
    print(f"{char * width}")


def print_graph_state(pipeline):
    """Show current graph state."""
    stats = pipeline.stats()
    print(f"\n  Graph: {stats['session_nodes']} session nodes, "
          f"{stats['prompt_nodes']} prompt nodes, "
          f"{stats['total_edges']} edges")

    # Show top nodes by weight
    nodes = pipeline.graph.list_nodes(layer="session", limit=10)
    if nodes:
        print(f"  Top session nodes:")
        for n in nodes[:8]:
            tags = ", ".join(n.tags[:3]) if n.tags else "none"
            print(f"    @{n.id} [{tags}] w={n.weight:.1f}: {n.summary[:60]}")

    # Show strongest edges
    edges = pipeline.graph.conn.execute(
        "SELECT source_id, target_id, weight, edge_type FROM edges ORDER BY weight DESC LIMIT 5"
    ).fetchall()
    if edges:
        print(f"  Strongest edges:")
        for src, tgt, w, etype in edges:
            print(f"    @{src} --{etype}--> @{tgt} (w={w:.0f})")


def main():
    # Clean start
    if os.path.exists("/tmp/composia-demo"):
        shutil.rmtree("/tmp/composia-demo")

    print_header("COMPOSIA CONTEXT ENGINE v2 — DEMO")
    print("Simulating: User building a notes app for 100k users")
    print(f"Pipeline: 13-step graph (decompose → RAG → traverse → resynthesize → render → reason)")
    print(f"Storage: SQLite ({DB_PATH})")
    print()

    pipeline = ContextPipeline(
        db_path=DB_PATH,
        auto_approve=True,
    )

    for i, prompt in enumerate(DEMO_PROMPTS):
        print_header(f"TURN {i+1}/{len(DEMO_PROMPTS)}", "─")
        print(f"\n  User: {prompt[:100]}{'...' if len(prompt) > 100 else ''}")

        start = time.time()

        # Run the full 13-step pipeline
        print(f"\n  [Steps 1-3] Decomposing into nodes + edges...")
        nodes, edges = pipeline.step_1_3_decompose(prompt, source="user")
        pipeline.graph.batch_put_nodes(nodes)
        pipeline.graph.batch_put_edges(edges)
        pipeline.step_4_index(nodes)
        print(f"    Created {len(nodes)} nodes, {len(edges)} edges")
        for n in nodes[:5]:
            print(f"      @{n.id} [{', '.join(n.tags[:2])}]: {n.summary[:55]}")
        if len(nodes) > 5:
            print(f"      ... and {len(nodes) - 5} more")

        print(f"\n  [Steps 5-7] RAG search + confidence traversal...")
        similar = pipeline.step_5_search(nodes)
        tuples = pipeline.step_6_build_tuples(nodes, similar)
        if tuples:
            tuples = pipeline.step_7_traverse(tuples)
            print(f"    Found {len(similar)} similar session nodes, {len(tuples)} tuples")
        else:
            print(f"    No similar session nodes (first turn or new topic)")

        print(f"\n  [Steps 8-9] Resynthesis + approval...")
        changes = pipeline.step_8_resynthesize(tuples, prompt_nodes=nodes)
        pipeline.step_9_approve(changes)
        print(f"    {changes.summary}")

        # Build similarity map
        similar_map = {}
        for t in tuples:
            pid = t.prompt_node.id
            if pid not in similar_map:
                similar_map[pid] = []
            similar_map[pid].append((t.session_node.id, t.similarity))

        print(f"\n  [Steps 10-11] Rendering prompt template...")
        system_prompt = pipeline.template.render_full(similar_map)
        prompt_len = len(system_prompt)
        print(f"    System prompt: {prompt_len} chars")

        print(f"\n  [Step 12] Sending to reasoning LLM...")
        response = pipeline.step_12_send(system_prompt, prompt)
        elapsed = time.time() - start

        print(f"\n  [Step 13] Processing response...")
        pipeline.step_13_process_response(response)

        # Clear prompt layer for next turn
        pipeline.graph.clear_layer("prompt")

        print(f"\n  Assistant: {response[:200]}{'...' if len(response) > 200 else ''}")

        print_graph_state(pipeline)
        print(f"\n  Turn time: {elapsed:.1f}s")

    print_header("DEMO COMPLETE")
    final = pipeline.stats()
    print(f"Final graph: {final['session_nodes']} session nodes, {final['total_edges']} edges")
    print(f"Database: {DB_PATH}")

    pipeline.close()


if __name__ == "__main__":
    main()
