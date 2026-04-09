"""Thin wrapper around the Anthropic API."""

import json
import re
import os

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))

import anthropic


class LLMClient:
    def __init__(self, model=None):
        self.client = anthropic.Anthropic()
        self.model = model or "claude-haiku-4-5-20251001"

    def call(self, prompt, system=None, max_tokens=4096, temperature=0):
        """Simple text completion."""
        kwargs = {
            "model": self.model,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "messages": [{"role": "user", "content": prompt}],
        }
        if system:
            kwargs["system"] = system
        resp = self.client.messages.create(**kwargs)
        return resp.content[0].text.strip()

    def call_json(self, prompt, system=None, max_tokens=4096, temperature=0):
        """Call LLM and parse JSON from response."""
        raw = self.call(prompt, system=system, max_tokens=max_tokens, temperature=temperature)
        # Strip markdown code fences
        cleaned = re.sub(r'```(?:json)?\s*', '', raw).strip()
        cleaned = re.sub(r'```\s*$', '', cleaned).strip()
        try:
            return json.loads(cleaned)
        except json.JSONDecodeError:
            # Try extracting object
            match = re.search(r'\{[\s\S]*\}', cleaned)
            if match:
                try:
                    return json.loads(match.group())
                except json.JSONDecodeError:
                    pass
            # Try array
            match = re.search(r'\[[\s\S]*\]', cleaned)
            if match:
                try:
                    return json.loads(match.group())
                except json.JSONDecodeError:
                    pass
            raise ValueError(f"Failed to parse JSON from LLM response: {raw[:200]}")
