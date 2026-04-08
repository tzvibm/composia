"""Steps 1-3: Decompose text into nodes and edges."""

from datetime import datetime

from .models import Node, Edge
from .llm_client import LLMClient
from .config import BUILD_MODEL


NODES_PROMPT = """Decompose the following text into atomic semantic elements. Return ONLY nodes — NO edges.

EVERY message must produce at least one node. Even greetings, questions, and casual remarks have structure.

Each node is one atomic element:
- **fact**: A specific claim. "Marcus enrolled in robotics at MIT on September 12th"
- **event**: Something that happened. Who, what, when, where. "Diana ran her first marathon in Portland on April 3"
- **feeling**: An emotion or attitude. "Tom felt overwhelmed by the workload"
- **decision**: A choice and why. "They picked the lakehouse because it was dog-friendly"
- **question**: Something asked. "Priya asked about the visa timeline"
- **greeting**: Social interaction. "User said hello and asked how things are going"
- **correction**: Something changed/updated. "Actually, I feel bad today" corrects a prior statement.
- **mood-change**: An emotional shift. Always note what changed FROM and TO. "User mood shifted from good to bad"
- **relationship**: Connection between people/things. "Sam and Jordan are business partners since 2019"
- **temporal**: Time-anchored fact. Always preserve exact date/time.
- **preference**: A like/dislike. "Elena prefers decaf coffee after 2pm"
- **plan**: Future intention. "Raj plans to submit the grant by November"
- **outcome**: A result. "The product launch exceeded targets by 40%"
- **specification**: A technical requirement with exact values. "Rate limit is 500 requests per minute per user"

Text to decompose ({source}):
{text}

Return JSON array of nodes:
[
  {{
    "id": "specific-slug-name",
    "title": "Short descriptive title",
    "tags": ["fact", "temporal"],
    "summary": "One sentence preserving ALL specific details",
    "content": "Full content preserving exact wording from source"
  }}
]

RULES:
- EVERY message MUST produce at least one node. Greetings produce a "greeting" node. Questions produce a "question" node.
- Do NOT create nodes for conversational filler: "Actually, wait", "Yeah", "Okay so", "I mean", "Like" — these are not semantic elements. Only extract substantive content.
- NEVER paraphrase. Use EXACT words from the source. If source says "astrophysics", write "astrophysics" not "space science".
- ALWAYS preserve exact numbers, values, and units. "500 requests per minute" must appear as "500 requests per minute", not "high rate limit".
- ALWAYS convert relative dates to absolute. If session is "January 15, 2025" and someone says "yesterday", store "January 14, 2025".
- Separate entities into distinct nodes: "Nicaragua, San Juan del Sur" = TWO nodes (country + city) connected by a "located_in" edge.
- One ATOMIC element per node. "Diana ran a marathon and felt exhausted" = TWO nodes.
- IDs should be specific: "diana-marathon-april3" not "marathon"
- Return ONLY valid JSON array."""


RESPONSE_NODES_PROMPT = """Extract ONLY substantive knowledge from this assistant response. IGNORE filler.

DO NOT extract:
- Greetings, pleasantries ("I'd be happy to help!", "Great question!")
- Meta-commentary ("Here's what I think:", "Based on the context:")
- Hedging ("I believe", "It seems like", "Perhaps")
- Restatements of what the user already said
- Transitional phrases ("Let me explain", "To summarize")
- Offers to help ("Let me know if you need anything else")

DO extract:
- New facts, recommendations, or suggestions the assistant provided
- Specific answers to questions (with exact values/names)
- Decisions or conclusions reached
- Action items or next steps proposed
- Corrections to prior information

Text to extract from (assistant response):
{text}

Return JSON array of nodes (ONLY substantive knowledge, often 0-3 nodes):
[
  {{
    "id": "specific-slug-name",
    "title": "Short descriptive title",
    "tags": ["recommendation", "fact", "answer", "action-item"],
    "summary": "One sentence with specific details",
    "content": "Full content preserving exact wording"
  }}
]

If the response is pure filler with no substantive knowledge, return: []
Return ONLY valid JSON array."""


EDGES_PROMPT = """Given these nodes, generate directed edges between them.

Nodes:
{nodes_formatted}

Return a JSON array of edges. Each edge has:
- source_id: the node this edge comes FROM
- target_id: the node this edge goes TO
- edge_type: Use the MOST SPECIFIC type that fits:
  - "answers" — response addresses a question
  - "causes" — A leads to B
  - "constrains" — A limits/restricts B
  - "contradicts" — A conflicts with B
  - "corrects" — A updates/fixes B
  - "supports" — A reinforces/validates B
  - "part_of" — A is a component of B
  - "located_in" — A is geographically within B (city→country)
  - "contains" — A contains B
  - "temporal_sequence" — A happens before B
  - "spatial_sequence" — A is near/adjacent to B
  - "describes" — A provides detail about B
  - "informs" — A provides context for deciding B
  - "relates_to" — ONLY when no specific type fits
- context: brief explanation of why this edge exists

[
  {{
    "source_id": "node-a",
    "target_id": "node-b",
    "edge_type": "causes",
    "context": "brief why"
  }}
]

RULES:
- Only create edges between the listed nodes
- Every node should have at least one edge (unless truly isolated)
- Prefer specific edge types over generic "relates_to"
- Return ONLY valid JSON array. Return [] if no edges needed."""


class Decomposer:
    def __init__(self, llm=None):
        self.llm = llm or LLMClient(model=BUILD_MODEL)

    def decompose_to_nodes(self, text, source="user"):
        """Step 1: Break text into nodes WITHOUT edges.
        Uses stricter prompt for assistant responses to filter filler."""
        if not text.strip():
            return []

        if source == "assistant":
            prompt = RESPONSE_NODES_PROMPT.format(text=text)
        else:
            prompt = NODES_PROMPT.format(text=text, source=source)

        result = self.llm.call_json(prompt)

        if isinstance(result, dict) and "nodes" in result:
            result = result["nodes"]
        if not isinstance(result, list):
            return []

        now = datetime.utcnow().isoformat()
        nodes = []
        for item in result:
            if not isinstance(item, dict) or "id" not in item:
                continue
            node = Node(
                id=item["id"],
                layer="prompt",
                title=item.get("title", item["id"]),
                content=item.get("content", ""),
                summary=item.get("summary", ""),
                tags=item.get("tags", []),
                created=now,
                updated=now,
                last_accessed=now,
            )
            nodes.append(node)
        return nodes

    def generate_edges(self, nodes):
        """Step 2: Generate edges between nodes."""
        if len(nodes) < 2:
            return []

        nodes_formatted = "\n".join(
            f"- {n.id} [{', '.join(n.tags)}]: {n.summary}"
            for n in nodes
        )

        result = self.llm.call_json(
            EDGES_PROMPT.format(nodes_formatted=nodes_formatted)
        )

        if not isinstance(result, list):
            return []

        node_ids = {n.id for n in nodes}
        edges = []
        for item in result:
            if not isinstance(item, dict):
                continue
            src = item.get("source_id", "")
            tgt = item.get("target_id", "")
            if src in node_ids and tgt in node_ids and src != tgt:
                edges.append(Edge(
                    source_id=src,
                    target_id=tgt,
                    edge_type=item.get("edge_type", "relates_to"),
                    context=item.get("context", ""),
                ))
        return edges

    def build_prompt_graph(self, text, source="user"):
        """Steps 1-3 combined: text -> (nodes, edges)."""
        nodes = self.decompose_to_nodes(text, source=source)
        edges = self.generate_edges(nodes) if nodes else []
        return nodes, edges
