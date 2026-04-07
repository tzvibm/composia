"""
Wiki: markdown-based knowledge store.
Each page is a node. [[links]] are edges. The wiki is the context.
"""

import os
import re
import json
from pathlib import Path
from datetime import date


class Page:
    """A single wiki page = a node in the knowledge graph."""

    def __init__(self, slug, title="", tags=None, summary="", content="",
                 links=None, updated=None):
        self.slug = slug
        self.title = title or slug
        self.tags = tags or []
        self.summary = summary  # one-line summary for the index
        self.content = content  # full page content
        self.links = links or []  # outgoing [[references]]
        self.updated = updated or str(date.today())

    def to_markdown(self):
        frontmatter = [
            "---",
            f"title: {self.title}",
            f"tags: [{', '.join(self.tags)}]",
            f"summary: {self.summary}",
            f"updated: {self.updated}",
            "---",
        ]
        return "\n".join(frontmatter) + "\n\n" + self.content

    @staticmethod
    def from_markdown(slug, text):
        page = Page(slug)

        # Parse frontmatter
        fm_match = re.match(r'^---\n(.*?)\n---\n', text, re.DOTALL)
        if fm_match:
            fm = fm_match.group(1)
            for line in fm.split('\n'):
                if line.startswith('title:'):
                    page.title = line[6:].strip()
                elif line.startswith('tags:'):
                    tags_str = line[5:].strip().strip('[]')
                    page.tags = [t.strip() for t in tags_str.split(',') if t.strip()]
                elif line.startswith('summary:'):
                    page.summary = line[8:].strip()
                elif line.startswith('updated:'):
                    page.updated = line[8:].strip()
            page.content = text[fm_match.end():]
        else:
            page.content = text

        # Extract [[links]]
        page.links = re.findall(r'\[\[([^\]]+)\]\]', page.content)

        return page


class Wiki:
    """The wiki = the knowledge graph. Pages are nodes, [[links]] are edges."""

    def __init__(self, path):
        self.path = Path(path)
        self.pages_dir = self.path / "pages"
        self.pages = {}  # slug -> Page

    def init(self):
        """Create wiki directory structure."""
        self.pages_dir.mkdir(parents=True, exist_ok=True)

        log_path = self.path / "log.md"
        if not log_path.exists():
            log_path.write_text(f"# Wiki Log\n\n## [{date.today()}] init\n")

        return self

    def load(self):
        """Load all pages from disk."""
        self.pages = {}
        if self.pages_dir.exists():
            for f in self.pages_dir.glob("*.md"):
                slug = f.stem
                page = Page.from_markdown(slug, f.read_text())
                self.pages[slug] = page
        return self

    def save_page(self, page):
        """Write a page to disk and update in-memory store."""
        self.pages[page.slug] = page
        (self.pages_dir / f"{page.slug}.md").write_text(page.to_markdown())

    def get_page(self, slug):
        return self.pages.get(slug)

    def get_backlinks(self, slug):
        """Find all pages that link TO this slug."""
        return [p for p in self.pages.values() if slug in p.links]

    def get_connections(self):
        """Get all edges as (source, target) pairs."""
        edges = []
        for page in self.pages.values():
            for link in page.links:
                if link in self.pages:
                    edges.append((page.slug, link))
        return edges

    def append_log(self, entry):
        log_path = self.path / "log.md"
        current = log_path.read_text() if log_path.exists() else "# Wiki Log\n"
        log_path.write_text(current + f"\n## [{date.today()}] {entry}\n")

    def page_count(self):
        return len(self.pages)

    def all_slugs(self):
        return list(self.pages.keys())
