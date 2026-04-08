"""Adapter to run LoCoMo/BABILong benchmarks against the context engine."""

import os
import shutil

from .pipeline import ContextPipeline


class ContextEngineBenchAdapter:
    """Drop-in replacement for wiki system in benchmark harnesses."""

    def __init__(self, db_path, reason_model=None, build_model=None):
        self.db_path = db_path
        self.reason_model = reason_model
        self.build_model = build_model
        self.pipeline = None

    def reset(self):
        """Clear and reinitialize."""
        if self.pipeline:
            self.pipeline.close()
        if os.path.exists(self.db_path):
            os.remove(self.db_path)
        self.pipeline = ContextPipeline(
            db_path=self.db_path,
            reason_model=self.reason_model,
            build_model=self.build_model,
            auto_approve=True,
        )

    def ingest_text(self, text, source="context"):
        """Ingest a block of text into the session graph."""
        if not self.pipeline:
            self.reset()
        return self.pipeline.ingest(text, source=source)

    def ingest_conversation(self, turns, session_format=True):
        """Ingest conversation turns into session graph.
        turns: list of dicts with 'speaker', 'text', 'session', 'session_date'"""
        if not self.pipeline:
            self.reset()

        if session_format:
            # Group by session
            current_session = None
            session_text = []
            total_nodes = 0

            for turn in turns:
                if turn.get("session") != current_session:
                    if session_text:
                        total_nodes += self.pipeline.ingest(
                            "\n".join(session_text), source="conversation"
                        )
                    current_session = turn.get("session")
                    session_text = [f"[Session {current_session} — {turn.get('session_date', '')}]"]
                session_text.append(f"{turn['speaker']}: {turn['text']}")

            if session_text:
                total_nodes += self.pipeline.ingest(
                    "\n".join(session_text), source="conversation"
                )
            return total_nodes
        else:
            # Single block
            text = "\n".join(f"{t['speaker']}: {t['text']}" for t in turns)
            return self.pipeline.ingest(text, source="conversation")

    def answer_question(self, question):
        """Answer a question from the session graph."""
        if not self.pipeline:
            self.reset()
        return self.pipeline.answer(question)

    def stats(self):
        if self.pipeline:
            return self.pipeline.stats()
        return {}

    def close(self):
        if self.pipeline:
            self.pipeline.close()
