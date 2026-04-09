"""Steps 10-11: Deterministic graph-to-prompt rendering. No LLM calls."""

from .graph_store import GraphStore, compute_decayed_confidence


class PromptTemplate:
    def __init__(self, graph):
        self.graph = graph

    def render_session(self):
        """Step 10: Render session graph into deterministic prompt section."""
        nodes = self.graph.get_active_nodes(layer="session")
        if not nodes:
            return ""

        edges_by_source = {}
        edges_by_target = {}
        for node in nodes:
            fwd = self.graph.get_forward_edges(node.id)
            back = self.graph.get_back_edges(node.id)
            edges_by_source[node.id] = fwd
            edges_by_target[node.id] = back

        total_edges = sum(len(e) for e in edges_by_source.values())

        lines = [f"== SESSION CONTEXT ({len(nodes)} nodes, {total_edges} edges) ==", ""]

        # Node index
        lines.append("[NODE INDEX]")
        for node in nodes:
            conf = compute_decayed_confidence(node.confidence, node.last_accessed)
            tags_str = ", ".join(node.tags) if node.tags else "none"
            lines.append(f"@{node.id} [{tags_str}] w={node.weight:.1f} c={conf:.2f}")
            lines.append(f"  {node.summary}")

            fwd = edges_by_source.get(node.id, [])
            if fwd:
                edge_strs = [f"@{e.target_id} (w={e.weight:.0f})" for e in fwd[:8]]
                lines.append(f"  \u2192 {', '.join(edge_strs)}")

            back = edges_by_target.get(node.id, [])
            if back:
                edge_strs = [f"@{e.source_id} (w={e.weight:.0f})" for e in back[:8]]
                lines.append(f"  \u2190 {', '.join(edge_strs)}")

        # Node content
        lines.append("")
        lines.append("[NODE CONTENT]")
        for node in nodes:
            lines.append(f"--- @{node.id}: {node.title} ---")
            lines.append(node.content)
            lines.append("")

        return "\n".join(lines)

    def render_prompt(self, similar_map=None):
        """Step 11: Render prompt graph into deterministic prompt section.
        similar_map: {prompt_node_id: [(session_node_id, score), ...]}"""
        nodes = self.graph.list_nodes(layer="prompt")
        if not nodes:
            return ""

        similar_map = similar_map or {}

        lines = [f"== CURRENT INPUT ({len(nodes)} nodes) ==", ""]

        # Node index
        lines.append("[NODE INDEX]")
        for node in nodes:
            tags_str = ", ".join(node.tags) if node.tags else "none"
            lines.append(f"@{node.id} [{tags_str}] NEW")
            lines.append(f"  {node.summary}")

            # Similar session nodes
            sims = similar_map.get(node.id, [])
            if sims:
                sim_strs = [f"@{sid} ({score:.2f})" for sid, score in sims[:5]]
                lines.append(f"  SIMILAR: {', '.join(sim_strs)}")

            # Edges
            fwd = self.graph.get_forward_edges(node.id)
            if fwd:
                edge_strs = [f"@{e.target_id}" for e in fwd[:8]]
                lines.append(f"  \u2192 {', '.join(edge_strs)}")

        # Node content
        lines.append("")
        lines.append("[NODE CONTENT]")
        for node in nodes:
            lines.append(f"--- @{node.id}: {node.title} ---")
            lines.append(node.content)
            lines.append("")

        return "\n".join(lines)

    def render_full(self, similar_map=None):
        """Render complete system prompt: session + prompt graphs."""
        session = self.render_session()
        prompt = self.render_prompt(similar_map)

        parts = []
        if session:
            parts.append(session)
        if prompt:
            parts.append(prompt)
        # Instruction at END so it's freshest in context after the graph
        parts.append("Respond to the user naturally. Be concise and direct — no filler, no lists of options, no preamble.")

        return "\n\n".join(parts)
