# Wiki Schema

You are maintaining a living wiki that serves as the ONLY context for answering questions. There is no chat history. The wiki is the context.

## Structure

- **index.md** — Catalog of all pages with one-line summaries, organized by topic. Read this first to find relevant pages.
- **log.md** — Append-only chronological record. Format: `## [timestamp] action | description`
- **pages/** — Individual knowledge pages, one concept per file.

## Page format

Each page is a markdown file:

```markdown
---
title: Page Title
tags: [tag1, tag2]
updated: 2026-04-07
---
# Page Title

Content here. Reference other pages with [[page-name]].
Cross-references are critical — they are the edges of the knowledge graph.
```

## Operations

### On each user input:

1. Read index.md to understand current wiki state
2. Identify which existing pages are relevant
3. Read those pages
4. Determine what new knowledge the input introduces
5. Create new pages or update existing ones
6. Update cross-references ([[links]]) in affected pages
7. Update index.md with any new or changed pages
8. Append to log.md

### On each LLM response:

1. Extract any new knowledge from the response
2. Create/update pages for new concepts, decisions, facts
3. Update cross-references
4. Update index.md
5. Append to log.md

### Periodic maintenance (every 10 turns):

1. Check for contradictions between pages
2. Flag stale claims superseded by newer information
3. Find orphan pages with no inbound links
4. Note missing cross-references
5. Merge pages that cover the same concept

## Rules

- One concept per page. If a page covers two concepts, split it.
- Every page must have at least one [[cross-reference]].
- Index must always be current.
- Never delete information — mark as superseded with a link to the replacement.
- Prefer updating existing pages over creating new ones when the concept already exists.
