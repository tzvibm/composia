"""Steps 8-9: Propose graph mutations and apply with approval."""

import json

from .models import Node, Edge, ChangeSet, TraversalTuple
from .graph_store import GraphStore
from .llm_client import LLMClient
from .config import BUILD_MODEL


RESYNTHESIZE_PROMPT = """You are maintaining a knowledge graph. Given pairs of new input nodes and existing session nodes, propose changes to the session graph.

Pairs (new input <-> existing knowledge):
{tuples_formatted}

For each pair, decide what to do:
- **resynthesize**: Merge new and existing content into improved content
- **correct**: The new input corrects/updates existing knowledge
- **add_content**: Add new details to existing node
- **update_summary**: Update a node's summary to be more accurate
- **delete**: Remove a node that is wrong or superseded
- **new_edge**: Create a new connection between nodes
- **remove_edge**: Remove an incorrect connection
- **promote**: New prompt nodes that should become session knowledge

Also evaluate each NEW node for 5W1H completeness (Who, What, Where, When, Why, How).
Include a "completeness" section showing which dimensions are missing.

Return JSON:
{{
  "resynthesize": [["node-id", "new merged content"]],
  "correct": [["node-id", "corrected content"]],
  "add_content": [["node-id", "additional content to append"]],
  "update_summaries": [["node-id", "new summary"]],
  "delete": ["node-id-to-remove"],
  "new_edges": [{{"source_id": "a", "target_id": "b", "edge_type": "relates_to", "context": "why"}}],
  "remove_edges": [["source-id", "target-id"]],
  "promote_nodes": ["prompt-node-id-to-keep"],
  "completeness": [
    {{"node_id": "id", "score": 0.0-1.0, "missing": ["When is this happening?", "Why was this decided?"]}}
  ],
  "summary": "Human-readable summary of all changes in 2-3 sentences"
}}

RULES:
- Preserve exact wording from source when possible
- If new input contradicts existing, prefer the new input (it's a correction)
- When a state changes (mood, preference, decision), create a CHANGE node (tag: "change") recording from/to, don't just overwrite
- If a change has no stated cause, include "UNKNOWN CAUSE" in the summary
- Always promote prompt nodes that contain new information
- Return ONLY valid JSON"""


class Resynthesizer:
    def __init__(self, graph, llm=None):
        self.graph = graph
        self.llm = llm or LLMClient(model=BUILD_MODEL)

    def propose_changes(self, tuples, prompt_nodes=None):
        """Step 8: Propose graph mutations + 5W1H completeness info."""
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

        return self._parse_changes(result, prompt_nodes, tuples)

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

    def _parse_changes(self, result, prompt_nodes, tuples):
        if not isinstance(result, dict):
            result = {}

        changeset = ChangeSet(
            resynthesize=result.get("resynthesize", []),
            correct=result.get("correct", []),
            add_content=result.get("add_content", []),
            update_summaries=result.get("update_summaries", []),
            delete=result.get("delete", []),
            new_edges=[
                Edge(
                    source_id=e["source_id"], target_id=e["target_id"],
                    edge_type=e.get("edge_type", "relates_to"),
                    context=e.get("context", ""),
                )
                for e in result.get("new_edges", [])
                if isinstance(e, dict) and "source_id" in e
            ],
            remove_edges=result.get("remove_edges", []),
            promote_nodes=result.get("promote_nodes", []),
            summary=result.get("summary", "Changes proposed."),
        )

        # Store completeness info for display
        changeset.properties["completeness"] = result.get("completeness", [])

        # If no promote_nodes specified, promote all prompt nodes
        if not changeset.promote_nodes and prompt_nodes:
            changeset.promote_nodes = [n.id for n in prompt_nodes]

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

        for node_id, new_content in changes.resynthesize:
            node = self.graph.get_node(node_id)
            if node:
                node.content = new_content
                self.graph.put_node(node)

        for node_id, correction in changes.correct:
            node = self.graph.get_node(node_id)
            if node:
                node.content = correction
                self.graph.put_node(node)

        for node_id, additional in changes.add_content:
            node = self.graph.get_node(node_id)
            if node:
                node.content += f"\n\n{additional}"
                self.graph.put_node(node)

        for node_id, new_summary in changes.update_summaries:
            node = self.graph.get_node(node_id)
            if node:
                node.summary = new_summary
                self.graph.put_node(node)

        for node_id in changes.delete:
            self.graph.delete_node(node_id)

        for edge in changes.new_edges:
            self.graph.put_edge(edge)

        for source_id, target_id in changes.remove_edges:
            self.graph.remove_edge(source_id, target_id)

        if changes.promote_nodes:
            self.graph.promote_nodes(changes.promote_nodes, to_layer="session")

        return changes
