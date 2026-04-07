"""
Wiki Updater: decomposes text (user input or LLM response) into wiki pages.
Uses a fast LLM to extract knowledge and update the wiki.
"""

import json
import re
from datetime import date

import anthropic

from wiki import Page


UPDATE_PROMPT = """You maintain a knowledge wiki. Given new text from a conversation, extract knowledge and return wiki operations as JSON.

Current wiki pages (summaries):
{summaries}

New text to process ({source}):
{text}

Return a JSON object:
{{
  "pages": {{
    "slug-name": {{
      "title": "Page Title",
      "tags": ["tag1", "tag2"],
      "summary": "One line summary for the index",
      "content": "Full page content with [[cross-references]] to other pages. Use [[slug]] format.",
      "action": "create" or "update"
    }}
  }},
  "log": "Brief description of what changed"
}}

Rules:
- One concept per page
- Slugs are lowercase-hyphenated
- Every page should [[link]] to related pages
- If a concept already exists, UPDATE it (merge new info) rather than creating a duplicate
- Extract decisions, facts, concepts, corrections — anything worth remembering
- Keep summaries to one sentence
- If nothing worth extracting, return {{"pages": {{}}, "log": null}}
- Return ONLY valid JSON"""


class WikiUpdater:
    def __init__(self, wiki, model="claude-haiku-4-5-20251001"):
        self.wiki = wiki
        self.client = anthropic.Anthropic()
        self.model = model

    def _get_summaries(self):
        lines = []
        for slug, page in self.wiki.pages.items():
            summary = page.summary or page.content[:80].replace('\n', ' ')
            lines.append(f"- {slug}: {summary}")
        return "\n".join(lines) if lines else "(no pages yet)"

    def update(self, text, source="user"):
        """Decompose text into wiki page updates."""
        if not text.strip():
            return {"pages_updated": 0}

        response = self.client.messages.create(
            model=self.model,
            max_tokens=4096,
            messages=[{
                "role": "user",
                "content": UPDATE_PROMPT.format(
                    summaries=self._get_summaries(),
                    source=source,
                    text=text
                )
            }]
        )

        raw = response.content[0].text.strip()

        # Parse JSON
        try:
            ops = json.loads(raw)
        except json.JSONDecodeError:
            match = re.search(r'\{[\s\S]*\}', raw)
            if match:
                try:
                    ops = json.loads(match.group())
                except json.JSONDecodeError:
                    return {"pages_updated": 0, "error": "Failed to parse update"}
            else:
                return {"pages_updated": 0, "error": "No JSON in response"}

        pages_updated = 0

        if ops.get("pages"):
            for slug, data in ops["pages"].items():
                if not data:
                    continue

                if data.get("action") == "update" and slug in self.wiki.pages:
                    # Merge into existing page
                    existing = self.wiki.pages[slug]
                    existing.content = data.get("content", existing.content)
                    existing.summary = data.get("summary", existing.summary)
                    existing.tags = data.get("tags", existing.tags)
                    existing.updated = str(date.today())
                    existing.links = re.findall(r'\[\[([^\]]+)\]\]', existing.content)
                    self.wiki.save_page(existing)
                else:
                    # Create new page
                    page = Page(
                        slug=slug,
                        title=data.get("title", slug),
                        tags=data.get("tags", []),
                        summary=data.get("summary", ""),
                        content=data.get("content", ""),
                    )
                    page.links = re.findall(r'\[\[([^\]]+)\]\]', page.content)
                    self.wiki.save_page(page)

                pages_updated += 1

        if ops.get("log"):
            self.wiki.append_log(f"{source} | {ops['log']}")

        return {"pages_updated": pages_updated}
