"""Configuration constants for the context engine."""

import os

# LLM models
REASON_MODEL = os.environ.get("COMPOSIA_MODEL", "claude-sonnet-4-20250514")
BUILD_MODEL = os.environ.get("COMPOSIA_BUILDER_MODEL", "claude-haiku-4-5-20251001")

# Embedding model
EMBED_MODEL = "BAAI/bge-small-en-v1.5"
EMBED_DIMS = 384

# Decay parameters
DECAY_HALF_LIFE_DAYS = 30.0
REINFORCE_WEIGHT = 0.5
REINFORCE_CONFIDENCE = 0.15
MAX_CONFIDENCE = 1.0
MIN_CONFIDENCE_ACTIVE = 0.1

# Retrieval
RAG_TOP_K = 20
SIMILARITY_THRESHOLD = 0.6

# Confidence traversal (step 7)
CONFIDENCE_THRESHOLD = 0.7
MAX_TRAVERSAL_ITERATIONS = 3

# Graph
MAX_GRAPH_DEPTH = 5
DEFAULT_DB_PATH = ".composia/context.db"
