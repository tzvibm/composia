"""Steps 8-9: Evaluate completeness, propose graph mutations, apply with approval."""

import json

from .models import Node, Edge, ChangeSet, TraversalTuple
from .graph_store import GraphStore
from .llm_client import LLMClient
from .config import BUILD_MODEL


RESYNTHESIZE_PROMPT = """You are maintaining a knowledge graph. Given pairs of new input nodes and existing session nodes:

1. EVALUATE each new node for 5W1H completeness (Who, What, Where, When, Why, How)
2. PROPOSE changes to the session graph

Pairs (new input <-> existing knowledge):
{tuples_formatted}

Return JSON with TWO sections:

{{
  "completeness": [
    {{
      "node_id": "the-node-id",
      "who": {{"present": true/false, "value": "..." or null}},
      "what": {{"present": true/false, "value": "..." or null}},
      "where": {{"present": true/false, "value": "..." or null}},
      "when": {{"present": true/false, "value": "..." or null}},
      "why": {{"present": true/false, "value": "..." or null}},
      "how": {{"present": true/false, "value": "..." or null}},
      "score": 0.0-1.0,
      "missing_questions": ["What is the budget?", "When is the trip?"]
    }}
  ],
  "changes": {{
    "resynthesize": [["node-id", "new merged content"]],
    "correct": [["node-id", "corrected content"]],
    "add_content": [["node-id", "additional content to append"]],
    "update_summaries": [["node-id", "new summary"]],
    "delete": ["node-id-to-remove"],
    "new_edges": [{{"source_id": "a", "target_id": "b", "edge_type": "relates_to", "context": "why"}}],
    "remove_edges": [["source-id", "target-id"]],
    "promote_nodes": ["prompt-node-id-to-keep"],
    "summary": "Human-readable summary of all changes in 2-3 sentences"
  }}
}}

RULES:
- Evaluate EVERY new node for 5W1H. Not all apply to every node (a greeting doesn't need "where") — score accordingly.
- missing_questions should be specific, actionable questions to ask the user.
- score is the fraction of APPLICABLE 5W1H dimensions that are present (0.0-1.0).
- Preserve exact wording from source when possible.
- If new input contradicts existing, prefer the new input (it's a correction).
- When a state changes (mood, preference, decision), create a CHANGE node (tag: "change") recording from/to, don't just overwrite.
- If a change has no stated cause, include "UNKNOWN CAUSE" in the summary.
- Always promote prompt nodes that contain new information.
- Return ONLY valid JSON."""


FOLLOWUP_PROMPT = """The user provided additional information to complete incomplete nodes.

Original nodes with gaps:
{incomplete_nodes}

User's additional input:
{user_input}

Update the nodes with the new information and re-evaluate completeness.
Return the same JSON format as before (completeness + changes).
Only include nodes that were updated or are still incomplete.

Return ONLY valid JSON with the same structure as before."""


class Resynthesizer:
    def __init__(self, graph, llm=None):
        self.graph = graph
        self.llm = llm or LLMClient(model=BUILD_MODEL)

    def propose_changes(self, tuples, prompt_nodes=None, interactive=False,
                        completeness_threshold=0.7, max_loops=3):
        """Step 8: Evaluate 5W1H completeness + propose graph mutations.

        If interactive=True, loops until all nodes reach completeness_threshold,
        asking the user for missing information at each iteration.
        """
        if not tuples and not prompt_nodes:
            return ChangeSet(summary="Nothing to process.")

        # Build the LLM prompt
        lines = self._format_tuples(tuples)

        # Include orphan prompt nodes (no matching session nodes)
        matched_prompt_ids = {t.prompt_node.id for t in tuples} if tuples else set()
        if prompt_nodes:
            for pn in prompt_nodes:
                if pn.id not in matched_prompt_ids:
                    lines.append(
                        f"NEW @{pn.id} [{', '.join(pn.tags)}]:\n"
                        f"  Summary: {pn.summary}\n"
                        f"  Content: {pn.content[:300]}\n"
                        f"EXISTING: (no match found)\n"
                        f"  Similarity: 0.0"
                    )

        if not lines:
            prompt_ids = [n.id for n in (prompt_nodes or [])]
            return ChangeSet(
                promote_nodes=prompt_ids,
                summary="No existing knowledge. All new input promoted to session.",
            )

        # First evaluation
        try:
            result = self.llm.call_json(
                RESYNTHESIZE_PROMPT.format(tuples_formatted="\n\n".join(lines))
            )
        except (ValueError, Exception) as e:
            prompt_ids = list(matched_prompt_ids | {n.id for n in (prompt_nodes or [])})
            return ChangeSet(
                promote_nodes=prompt_ids,
                summary=f"Resynthesis failed ({e}). Promoting all new nodes.",
            )

        completeness = result.get("completeness", [])
        changes_data = result.get("changes", result)  # fallback if flat structure

        # Interactive completeness loop
        if interactive and completeness:
            for loop in range(max_loops):
                incomplete = [c for c in completeness
                              if c.get("score", 1.0) < completeness_threshold
                              and c.get("missing_questions")]
                if not incomplete:
                    break

                # Show gaps and ask user
                print(f"\n  Incomplete nodes ({len(incomplete)}):")
                all_questions = []
                for c in incomplete:
                    nid = c["node_id"]
                    score = c.get("score", 0)
                    questions = c.get("missing_questions", [])
                    print(f"    @{nid} (completeness: {score:.0%})")
                    for q in questions:
                        print(f"      ? {q}")
                        all_questions.append(q)

                if not all_questions:
                    break

                try:
                    user_answer = input(f"\n  Answer (or ENTER to skip): ").strip()
                except EOFError:
                    break

                if not user_answer:
                    break

                # Re-evaluate with user's additional info
                incomplete_formatted = "\n".join(
                    f"@{c['node_id']} (score: {c.get('score', 0):.0%}): "
                    f"missing: {', '.join(c.get('missing_questions', []))}"
                    for c in incomplete
                )
                try:
                    result = self.llm.call_json(
                        FOLLOWUP_PROMPT.format(
                            incomplete_nodes=incomplete_formatted,
                            user_input=user_answer,
                        )
                    )
                    completeness = result.get("completeness", completeness)
                    changes_data = result.get("changes", changes_data)
                except (ValueError, Exception):
                    break

        return self._parse_changes(changes_data, completeness, prompt_nodes, tuples)

    def _format_tuples(self, tuples):
        lines = []
        seen_pairs = set()
        for t in tuples:
            pair_key = (t.prompt_node.id, t.session_node.id)
            if pair_key in seen_pairs:
                continue
            seen_pairs.add(pair_key)

            session_edge_str = ", ".join(
                f"->@{e.target_id} ({e.edge_type})" for e in t.session_edges[:5]
            )
            lines.append(
                f"NEW @{t.prompt_node.id} [{', '.join(t.prompt_node.tags)}]:\n"
                f"  Summary: {t.prompt_node.summary}\n"
                f"  Content: {t.prompt_node.content[:300]}\n"
                f"EXISTING @{t.session_node.id} [{', '.join(t.session_node.tags)}]:\n"
                f"  Summary: {t.session_node.summary}\n"
                f"  Content: {t.session_node.content[:300]}\n"
                f"  Edges: {session_edge_str}\n"
                f"  Similarity: {t.similarity:.2f}"
            )
        return lines

    def _parse_changes(self, changes_data, completeness, prompt_nodes, tuples):
        """Parse the LLM's response into a ChangeSet."""
        # Handle both nested and flat formats
        if isinstance(changes_data, dict) and "changes" in changes_data:
            changes_data = changes_data["changes"]
        if not isinstance(changes_data, dict):
            changes_data = {}

        changeset = ChangeSet(
            resynthesize=changes_data.get("resynthesize", []),
            correct=changes_data.get("correct", []),
            add_content=changes_data.get("add_content", []),
            update_summaries=changes_data.get("update_summaries", []),
            delete=changes_data.get("delete", []),
            new_edges=[
                Edge(
                    source_id=e["source_id"], target_id=e["target_id"],
                    edge_type=e.get("edge_type", "relates_to"),
                    context=e.get("context", ""),
                )
                for e in changes_data.get("new_edges", [])
                if isinstance(e, dict) and "source_id" in e
            ],
            remove_edges=changes_data.get("remove_edges", []),
            promote_nodes=changes_data.get("promote_nodes", []),
            summary=changes_data.get("summary", "Changes proposed."),
        )

        # If no promote_nodes specified, promote all prompt nodes
        if not changeset.promote_nodes and prompt_nodes:
            matched = {t.prompt_node.id for t in tuples} if tuples else set()
            unmatched = [n.id for n in prompt_nodes if n.id not in matched]
            if unmatched:
                changeset.promote_nodes = unmatched

        # Attach completeness data for display
        changeset.properties["completeness"] = completeness

        return changeset

    def apply_changes(self, changes, auto_approve=False):
        """Step 9: Apply the ChangeSet to the graph."""
        if not auto_approve:
            print(f"\n--- Proposed Changes ---")
            print(f"{changes.summary}")
            print(f"  Resynthesize: {len(changes.resynthesize)}")
            print(f"  Correct: {len(changes.correct)}")
            print(f"  Add content: {len(changes.add_content)}")
            print(f"  Update summaries: {len(changes.update_summaries)}")
            print(f"  Delete: {len(changes.delete)}")
            print(f"  New edges: {len(changes.new_edges)}")
            print(f"  Remove edges: {len(changes.remove_edges)}")
            print(f"  Promote: {len(changes.promote_nodes)}")
            approval = input("Approve? [y/N]: ").strip().lower()
            if approval != "y":
                return changes

        # Apply resynthesis
        for node_id, new_content in changes.resynthesize:
            node = self.graph.get_node(node_id)
            if node:
                node.content = new_content
                self.graph.put_node(node)

        # Apply corrections
        for node_id, correction in changes.correct:
            node = self.graph.get_node(node_id)
            if node:
                node.content = correction
                self.graph.put_node(node)

        # Add content
        for node_id, additional in changes.add_content:
            node = self.graph.get_node(node_id)
            if node:
                node.content += f"\n\n{additional}"
                self.graph.put_node(node)

        # Update summaries
        for node_id, new_summary in changes.update_summaries:
            node = self.graph.get_node(node_id)
            if node:
                node.summary = new_summary
                self.graph.put_node(node)

        # Delete nodes
        for node_id in changes.delete:
            self.graph.delete_node(node_id)

        # New edges
        for edge in changes.new_edges:
            self.graph.put_edge(edge)

        # Remove edges
        for source_id, target_id in changes.remove_edges:
            self.graph.remove_edge(source_id, target_id)

        # Promote prompt nodes to session
        if changes.promote_nodes:
            self.graph.promote_nodes(changes.promote_nodes, to_layer="session")

        return changes
