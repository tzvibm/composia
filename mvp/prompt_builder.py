"""
Prompt Builder: assembles the wiki into a structured context prompt.

The prompt has three sections:
1. ALL nodes as summaries (the full knowledge state, lightweight)
2. RELEVANT nodes expanded (full content for pages matching this turn)
3. CONNECTIONS in English (how the relevant nodes relate to each other)
"""

import anthropic


RELEVANCE_PROMPT = """Given the user's message and a list of wiki page summaries, return a JSON array of slugs that are relevant to answering this message. Include pages that are directly relevant AND pages that provide important context.

User message: {user_message}

Wiki pages:
{summaries}

Return ONLY a JSON array of slug strings. Example: ["jwt-auth", "api-gateway"]
If nothing is relevant, return: []"""


EXTRACT_PROMPT = """Given a user's current question and a wiki page, extract ONLY the parts of this page that are relevant to answering the question. Do not include unrelated content even if it's on the same page.

User's question: {user_message}

Page: {page_title} ({page_slug})
Full content:
{page_content}

Extract the relevant portions. Keep [[cross-references]] intact. If nothing on this page is relevant, respond with: NOTHING_RELEVANT
Be concise — include only what helps answer the question."""


CONNECTION_PROMPT = """Describe how these wiki pages connect to each other in plain English. Each connection should explain WHY the relationship matters, not just that it exists.

Pages and their links:
{pages_with_links}

Write one line per connection in this format:
- source → target: explanation of why this connection matters

Only include connections between the pages listed. Be concise."""


class PromptBuilder:
    def __init__(self, wiki, model="claude-haiku-4-5-20251001"):
        self.wiki = wiki
        self.client = anthropic.Anthropic()
        self.model = model

    def _get_summaries_text(self):
        """Build a text block of all page summaries."""
        lines = []
        for slug, page in self.wiki.pages.items():
            summary = page.summary or page.content[:100].replace('\n', ' ')
            tags = f" [{', '.join(page.tags)}]" if page.tags else ""
            lines.append(f"- {slug}{tags}: {summary}")
        return "\n".join(lines) if lines else "(no pages yet)"

    def _find_relevant_pages(self, user_message):
        """Use LLM to decide which pages are relevant to this turn."""
        if not self.wiki.pages:
            return []

        summaries = self._get_summaries_text()

        response = self.client.messages.create(
            model=self.model,
            max_tokens=1024,
            messages=[{
                "role": "user",
                "content": RELEVANCE_PROMPT.format(
                    user_message=user_message,
                    summaries=summaries
                )
            }]
        )

        text = response.content[0].text.strip()
        # Extract JSON array
        import json, re
        match = re.search(r'\[.*?\]', text, re.DOTALL)
        if match:
            try:
                slugs = json.loads(match.group())
                return [s for s in slugs if s in self.wiki.pages]
            except json.JSONDecodeError:
                pass
        return []

    def _extract_relevant_content(self, page, user_message):
        """Extract only the parts of a page relevant to this turn's question."""
        response = self.client.messages.create(
            model=self.model,
            max_tokens=2048,
            messages=[{
                "role": "user",
                "content": EXTRACT_PROMPT.format(
                    user_message=user_message,
                    page_title=page.title,
                    page_slug=page.slug,
                    page_content=page.content
                )
            }]
        )
        text = response.content[0].text.strip()
        if text == "NOTHING_RELEVANT":
            return None
        return text

    def _describe_connections(self, relevant_slugs):
        """Use LLM to describe connections between relevant pages in English."""
        if len(relevant_slugs) < 2:
            return ""

        # Build context of pages and their links
        lines = []
        for slug in relevant_slugs:
            page = self.wiki.pages[slug]
            links_to = [l for l in page.links if l in self.wiki.pages]
            backlinks = [p.slug for p in self.wiki.get_backlinks(slug)]
            lines.append(f"{slug} ('{page.title}')")
            if links_to:
                lines.append(f"  links to: {', '.join(links_to)}")
            if backlinks:
                lines.append(f"  linked from: {', '.join(backlinks)}")

        response = self.client.messages.create(
            model=self.model,
            max_tokens=1024,
            messages=[{
                "role": "user",
                "content": CONNECTION_PROMPT.format(
                    pages_with_links="\n".join(lines)
                )
            }]
        )

        return response.content[0].text.strip()

    def build(self, user_message):
        """Build the full context prompt from the wiki state + user message."""

        sections = []

        # Section 1: All nodes as summaries
        summaries = self._get_summaries_text()
        if self.wiki.pages:
            sections.append(
                "== KNOWLEDGE STATE (all known concepts) ==\n\n"
                f"{summaries}"
            )

        # Section 2: Find and expand relevant nodes
        relevant = self._find_relevant_pages(user_message)

        if relevant:
            expanded = []
            for slug in relevant:
                page = self.wiki.pages[slug]
                # Extract only the parts relevant to this question
                extracted = self._extract_relevant_content(page, user_message)
                if extracted:
                    expanded.append(f"### {page.title} ({slug})\n\n{extracted}")

            if expanded:
                sections.append(
                    "== RELEVANT CONTEXT (extracted for this question) ==\n\n"
                    + "\n\n---\n\n".join(expanded)
                )

            # Section 3: Connections in English
            connections = self._describe_connections(relevant)
            if connections:
                sections.append(
                    "== HOW THESE CONNECT ==\n\n"
                    f"{connections}"
                )

        # Assemble system prompt
        if sections:
            system = (
                "You are an assistant whose knowledge comes entirely from a wiki "
                "that is built and maintained during this interaction. The wiki below "
                "is your ONLY source of truth. Do not rely on prior knowledge — "
                "if it's not in the wiki, you don't know it.\n\n"
                "When the wiki is empty or lacks information, say so honestly.\n\n"
                + "\n\n".join(sections)
            )
        else:
            system = (
                "You are an assistant. This is the start of a new interaction. "
                "A wiki will be built as we go — it will become your knowledge source. "
                "For now, answer based on your general knowledge and the wiki will "
                "capture what matters."
            )

        return system, relevant
