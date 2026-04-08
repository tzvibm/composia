#!/usr/bin/env python3
"""
Automated evaluation loop for the context engine.

Generates contextually-aware prompts, runs the 13-step pipeline,
critiques every step, and saves results for system optimization.

Usage:
  python3 eval_loop.py [--cycles 20] [--scenario travel]
"""

import os
import sys
import json
import shutil
import time
import argparse
from datetime import datetime

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), '.env'))

from context_engine.pipeline import ContextPipeline
from context_engine.llm_client import LLMClient
from context_engine.config import BUILD_MODEL, REASON_MODEL


SCENARIOS = {
    "travel": {
        "description": "User planning a trip to Nicaragua, 30 years old, currently in San Juan del Sur",
        "seed": "Hello, I'm 30 years old and currently in San Juan del Sur, Nicaragua. I want to plan my travel itinerary from here.",
    },
    "startup": {
        "description": "User building a notes app for 100k users, deciding on tech stack",
        "seed": "I want to build a notes app that can handle 100k users with real-time collaboration and full-text search.",
    },
    "learning": {
        "description": "User learning Python, coming from JavaScript background",
        "seed": "I'm a JavaScript developer with 5 years experience and I want to learn Python. Where should I start?",
    },
}


GENERATE_PROMPT = """You are simulating a realistic user in a conversation. The conversation context is:

Scenario: {scenario_description}

Previous messages exchanged:
{history}

Current graph state (what the system knows):
{graph_summary}

Generate the next realistic user message. It should:
- Build on the conversation naturally
- Sometimes introduce new information (facts, preferences, feelings)
- Sometimes ask questions that require recalling prior context
- Sometimes correct or update previous statements
- Sometimes change mood or topic
- Be 1-3 sentences, natural and conversational

Return ONLY the user message, nothing else."""


CRITIQUE_PROMPT = """You are evaluating a knowledge graph system's processing of a user message. Rate each aspect 1-5 and explain issues.

User message: {user_message}

Step 1-3 (Decomposition):
  Nodes created: {nodes}
  Edges created (within this turn): {edges}

Step 5-7 (Retrieval):
  Similar nodes found: {similar_count}
  Top matches: {top_matches}

Step 8 (Resynthesis):
  Proposed changes: {changes_summary}
  Completeness: {completeness}

Step 12 (Response):
  LLM response: {response}

Response nodes added to graph: {response_nodes}

Full graph edges (ALL connections in session graph):
{all_edges}

Graph nodes after turn:
  {graph_state}

Rate these aspects (1-5):
1. **decomposition_quality**: Did it break the message into correct atomic elements? Were entities properly separated (e.g., country vs city as separate nodes)? Were dates, numbers preserved exactly?
2. **edge_quality**: Rate the FULL edge graph:
   - Are within-turn edges correctly typed (causes, temporal_sequence, describes, etc.)?
   - Are cross-turn edges present where they should be? (e.g., assistant recommendation → user question that prompted it)
   - Are response nodes correctly connected to the user prompt nodes they answer?
   - Are there missing edges between related nodes from different turns?
   - Are there spurious edges connecting unrelated nodes?
   - Do edge weights make sense (frequently co-occurring concepts should have higher weights)?
3. **retrieval_quality**: Did RAG find the right context? Were irrelevant nodes retrieved? Were relevant nodes missed?
4. **resynthesis_quality**: Were graph changes appropriate? Were corrections, merges, new edges proposed correctly? Were filler response nodes correctly filtered out?
5. **response_quality**: Was the LLM response informed by the graph context? Was it accurate and helpful?
6. **completeness_quality**: Were 5W1H gaps correctly identified?

Return JSON:
{{
  "decomposition_quality": {{"score": N, "issues": ["..."]}},
  "edge_quality": {{"score": N, "issues": ["specific edge problems like: '@user-location should connect to @trip-plan but doesn't'", "edge @A->@B is spurious, these nodes are unrelated"]}},
  "retrieval_quality": {{"score": N, "issues": ["..."]}},
  "resynthesis_quality": {{"score": N, "issues": ["..."]}},
  "response_quality": {{"score": N, "issues": ["..."]}},
  "completeness_quality": {{"score": N, "issues": ["..."]}},
  "overall_score": N,
  "missing_edges": [["source-node-id", "target-node-id", "why this edge should exist"]],
  "spurious_edges": [["source-node-id", "target-node-id", "why this edge shouldn't exist"]],
  "critical_issues": ["most important problems to fix"],
  "suggested_fixes": ["specific actionable improvements"]
}}"""


class EvalLoop:
    def __init__(self, scenario="travel", db_path=None, cycles=20):
        self.scenario = SCENARIOS.get(scenario, SCENARIOS["travel"])
        self.db_path = db_path or f"/tmp/composia-eval-{scenario}/context.db"
        self.cycles = cycles
        self.history = []  # (role, message) pairs
        self.results = []
        self.critic = LLMClient(model=REASON_MODEL)
        self.generator = LLMClient(model=BUILD_MODEL)

        # Clean start
        parent = os.path.dirname(self.db_path)
        if os.path.exists(parent):
            shutil.rmtree(parent)

        self.pipeline = ContextPipeline(
            db_path=self.db_path,
            auto_approve=True,
        )

    def generate_next_prompt(self):
        """Generate a contextually-aware user message based on current state."""
        if not self.history:
            return self.scenario["seed"]

        history_text = "\n".join(
            f"{'User' if role == 'user' else 'Assistant'}: {msg[:150]}"
            for role, msg in self.history[-10:]  # last 10 exchanges
        )

        nodes = self.pipeline.graph.list_nodes(layer="session", limit=15)
        graph_summary = "\n".join(
            f"  @{n.id} [{', '.join(n.tags[:2])}]: {n.summary[:60]}"
            for n in nodes
        ) or "  (empty)"

        prompt = self.generator.call(
            GENERATE_PROMPT.format(
                scenario_description=self.scenario["description"],
                history=history_text,
                graph_summary=graph_summary,
            ),
            max_tokens=200,
        )
        return prompt.strip().strip('"')

    def critique_turn(self, user_msg, nodes, edges, similar_count,
                      top_matches, changes, response, completeness,
                      response_nodes=None):
        """Critique every step of the pipeline for this turn."""
        nodes_str = "\n".join(
            f"  @{n.id} [{', '.join(n.tags)}]: {n.summary[:80]}"
            for n in nodes
        ) or "  (none)"

        edges_str = "\n".join(
            f"  @{e.source_id} --{e.edge_type}--> @{e.target_id}"
            for e in edges
        ) or "  (none)"

        # Response nodes
        resp_str = "\n".join(
            f"  @{n.id} [{', '.join(n.tags)}]: {n.summary[:80]}"
            for n in (response_nodes or [])
        ) or "  (none — filtered as filler)"

        # Full edge graph
        all_edges_rows = self.pipeline.graph.conn.execute(
            "SELECT source_id, target_id, weight, edge_type FROM edges ORDER BY weight DESC LIMIT 30"
        ).fetchall()
        all_edges_str = "\n".join(
            f"  @{src} --{etype}--> @{tgt} (w={w:.0f})"
            for src, tgt, w, etype in all_edges_rows
        ) or "  (no edges)"

        graph_nodes = self.pipeline.graph.list_nodes(layer="session", limit=25)
        graph_state = "\n".join(
            f"  @{n.id} [{', '.join(n.tags[:2])}] w={n.weight:.1f}: {n.summary[:50]}"
            for n in graph_nodes
        )

        completeness_str = json.dumps(completeness, indent=2)[:500] if completeness else "none"

        try:
            critique = self.critic.call_json(
                CRITIQUE_PROMPT.format(
                    user_message=user_msg,
                    nodes=nodes_str,
                    edges=edges_str,
                    similar_count=similar_count,
                    top_matches=top_matches,
                    changes_summary=changes.summary,
                    completeness=completeness_str,
                    response=response[:400],
                    response_nodes=resp_str,
                    all_edges=all_edges_str,
                    graph_state=graph_state,
                ),
                max_tokens=1500,
            )
            return critique
        except Exception as e:
            return {"error": str(e), "overall_score": 0}

    def run_turn(self, user_msg):
        """Run one turn through the pipeline with full instrumentation."""
        self.pipeline.graph.clear_layer("prompt")

        # Steps 1-3
        nodes, edges = self.pipeline.step_1_3_decompose(user_msg, source="user")
        if not nodes:
            from context_engine.models import Node
            nodes = [Node(id="user-query", layer="prompt", title=user_msg[:60],
                         content=user_msg, summary=user_msg, tags=["question"])]
            edges = []

        self.pipeline.graph.batch_put_nodes(nodes)
        self.pipeline.graph.batch_put_edges(edges)
        self.pipeline.step_4_index(nodes)

        # Steps 5-7
        similar = self.pipeline.step_5_search(nodes)
        tuples = self.pipeline.step_6_build_tuples(nodes, similar)
        top_matches = ", ".join(
            f"@{t.session_node.id} ({t.similarity:.2f})"
            for t in tuples[:5]
        ) or "none"
        if tuples:
            tuples = self.pipeline.step_7_traverse(tuples)

        # Step 8
        changes = self.pipeline.step_8_resynthesize(tuples, prompt_nodes=nodes)
        completeness = changes.properties.get("completeness", [])

        # Step 9
        self.pipeline.resynthesizer.apply_changes(changes, auto_approve=True)

        # Steps 10-12
        similar_map = {}
        for t in tuples:
            pid = t.prompt_node.id
            if pid not in similar_map:
                similar_map[pid] = []
            similar_map[pid].append((t.session_node.id, t.similarity))

        system_prompt = self.pipeline.template.render_full(similar_map)
        response = self.pipeline.step_12_send(system_prompt, user_msg)

        # Step 13
        prompt_ids = [n.id for n in nodes]
        resp_nodes, resp_edges = self.pipeline.step_13_process_response(response)
        if resp_nodes:
            self.pipeline.approve_response_graph(resp_nodes, prompt_node_ids=prompt_ids)
        self.pipeline.graph.clear_layer("prompt")

        return nodes, edges, len(similar), top_matches, changes, response, completeness, resp_nodes or []

    def run(self):
        """Run the full eval loop."""
        print(f"{'='*70}")
        print(f"COMPOSIA EVAL LOOP")
        print(f"Scenario: {self.scenario['description']}")
        print(f"Cycles: {self.cycles}")
        print(f"DB: {self.db_path}")
        print(f"{'='*70}")

        for cycle in range(self.cycles):
            # Generate prompt
            user_msg = self.generate_next_prompt()
            self.history.append(("user", user_msg))

            print(f"\n{'─'*70}")
            print(f"Cycle {cycle+1}/{self.cycles}")
            print(f"User: {user_msg[:100]}{'...' if len(user_msg) > 100 else ''}")

            start = time.time()
            nodes, edges, sim_count, top_matches, changes, response, completeness, resp_nodes = \
                self.run_turn(user_msg)
            elapsed = time.time() - start

            self.history.append(("assistant", response))

            # Measure context size
            system_prompt = self.pipeline.template.render_full()
            context_chars = len(system_prompt)
            context_tokens_est = context_chars // 4

            print(f"Nodes: {len(nodes)} | Edges: {len(edges)} | Similar: {sim_count} | Resp nodes: {len(resp_nodes)}")
            print(f"Context: ~{context_tokens_est:,} tokens ({context_chars:,} chars)")
            print(f"Changes: {changes.summary[:80]}")
            print(f"Response: {response[:120]}...")
            print(f"Time: {elapsed:.1f}s")

            # Critique
            print(f"Critiquing...")
            critique = self.critique_turn(
                user_msg, nodes, edges, sim_count, top_matches,
                changes, response, completeness, resp_nodes,
            )

            overall = critique.get("overall_score", 0)
            print(f"Score: {overall}/5")
            critical = critique.get("critical_issues", [])
            if critical:
                print(f"Issues: {'; '.join(critical[:3])}")

            stats = self.pipeline.stats()
            print(f"Graph: {stats['session_nodes']} nodes, {stats['total_edges']} edges")

            self.results.append({
                "cycle": cycle + 1,
                "user_message": user_msg,
                "nodes_created": len(nodes),
                "edges_created": len(edges),
                "similar_found": sim_count,
                "response_nodes": len(resp_nodes),
                "context_chars": context_chars,
                "context_tokens_est": context_tokens_est,
                "changes_summary": changes.summary,
                "response": response[:500],
                "critique": critique,
                "overall_score": overall,
                "elapsed": elapsed,
                "graph_stats": stats,
            })

        # Summary
        self._print_summary()
        self._save_results()

    def _print_summary(self):
        print(f"\n{'='*70}")
        print(f"EVAL SUMMARY ({len(self.results)} cycles)")
        print(f"{'='*70}")

        scores = [r["overall_score"] for r in self.results if r["overall_score"]]
        if scores:
            print(f"Average score: {sum(scores)/len(scores):.1f}/5")
            print(f"Min: {min(scores)}/5 | Max: {max(scores)}/5")

        # Context growth
        contexts = [r.get("context_tokens_est", 0) for r in self.results]
        if contexts:
            print(f"\nContext growth:")
            print(f"  Start: ~{contexts[0]:,} tokens")
            print(f"  End:   ~{contexts[-1]:,} tokens")
            print(f"  Growth: ~{contexts[-1] - contexts[0]:,} tokens over {len(contexts)} cycles")

        # Timing
        times = [r.get("elapsed", 0) for r in self.results]
        if times:
            print(f"\nTiming:")
            print(f"  Avg: {sum(times)/len(times):.1f}s | Total: {sum(times):.0f}s")

        # Token estimate (rough: ~4 LLM calls per cycle, ~2k tokens each)
        est_tokens = len(self.results) * 4 * 2000 + sum(contexts)
        print(f"\nEstimated total tokens: ~{est_tokens:,}")

        # Per-dimension averages
        dims = ["decomposition_quality", "edge_quality", "retrieval_quality",
                "resynthesis_quality", "response_quality", "completeness_quality"]
        for dim in dims:
            vals = []
            for r in self.results:
                c = r.get("critique", {})
                if isinstance(c.get(dim), dict):
                    vals.append(c[dim].get("score", 0))
            if vals:
                print(f"  {dim}: {sum(vals)/len(vals):.1f}/5")

        # Aggregate critical issues
        all_issues = []
        for r in self.results:
            all_issues.extend(r.get("critique", {}).get("critical_issues", []))
        if all_issues:
            # Count frequency
            from collections import Counter
            top = Counter(all_issues).most_common(10)
            print(f"\nTop issues (by frequency):")
            for issue, count in top:
                print(f"  [{count}x] {issue}")

        # Aggregate edge issues
        missing_edges = []
        spurious_edges = []
        for r in self.results:
            c = r.get("critique", {})
            missing_edges.extend(c.get("missing_edges", []))
            spurious_edges.extend(c.get("spurious_edges", []))
        if missing_edges:
            print(f"\nMissing edges ({len(missing_edges)} total):")
            for me in missing_edges[:10]:
                if len(me) >= 3:
                    print(f"  @{me[0]} -> @{me[1]}: {me[2]}")
        if spurious_edges:
            print(f"\nSpurious edges ({len(spurious_edges)} total):")
            for se in spurious_edges[:10]:
                if len(se) >= 3:
                    print(f"  @{se[0]} -> @{se[1]}: {se[2]}")

        # Aggregate suggested fixes
        all_fixes = []
        for r in self.results:
            all_fixes.extend(r.get("critique", {}).get("suggested_fixes", []))
        if all_fixes:
            from collections import Counter
            top = Counter(all_fixes).most_common(10)
            print(f"\nTop suggested fixes:")
            for fix, count in top:
                print(f"  [{count}x] {fix}")

    def _save_results(self):
        out_path = os.path.join(os.path.dirname(self.db_path), "eval_results.json")
        with open(out_path, "w") as f:
            json.dump({
                "scenario": self.scenario,
                "cycles": len(self.results),
                "results": self.results,
            }, f, indent=2)
        print(f"\nResults saved to {out_path}")

        self.pipeline.close()


def main():
    parser = argparse.ArgumentParser(description="Composia eval loop")
    parser.add_argument("--cycles", type=int, default=20, help="Number of cycles")
    parser.add_argument("--scenario", default="travel", choices=list(SCENARIOS.keys()))
    args = parser.parse_args()

    loop = EvalLoop(scenario=args.scenario, cycles=args.cycles)
    loop.run()


if __name__ == "__main__":
    main()
