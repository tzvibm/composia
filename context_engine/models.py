"""Data classes for the context engine."""

from dataclasses import dataclass, field
from datetime import datetime


@dataclass
class Node:
    id: str
    layer: str  # 'system' | 'session' | 'prompt'
    title: str
    content: str
    summary: str
    tags: list = field(default_factory=list)
    properties: dict = field(default_factory=dict)
    weight: float = 1.0
    confidence: float = 1.0
    access_count: int = 0
    created: str = ""
    updated: str = ""
    last_accessed: str = ""
    supersedes: str = None

    def __post_init__(self):
        now = datetime.utcnow().isoformat()
        if not self.created:
            self.created = now
        if not self.updated:
            self.updated = now
        if not self.last_accessed:
            self.last_accessed = now


@dataclass
class Edge:
    source_id: str
    target_id: str
    weight: float = 1.0
    edge_type: str = ""
    context: str = ""
    last_seen: str = ""

    def __post_init__(self):
        if not self.last_seen:
            self.last_seen = datetime.utcnow().isoformat()


@dataclass
class SimilarityResult:
    node: Node
    score: float


@dataclass
class TraversalTuple:
    prompt_node: Node
    session_node: Node
    similarity: float
    prompt_edges: list = field(default_factory=list)
    session_edges: list = field(default_factory=list)


@dataclass
class ChangeSet:
    resynthesize: list = field(default_factory=list)    # [(node_id, new_content)]
    correct: list = field(default_factory=list)          # [(node_id, correction)]
    add_content: list = field(default_factory=list)      # [(node_id, additional)]
    update_summaries: list = field(default_factory=list)  # [(node_id, new_summary)]
    delete: list = field(default_factory=list)            # [node_id]
    new_edges: list = field(default_factory=list)         # [Edge]
    remove_edges: list = field(default_factory=list)      # [(source_id, target_id)]
    promote_nodes: list = field(default_factory=list)     # [node_id] prompt -> session
    summary: str = ""
