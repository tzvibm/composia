# Context Engine — Wiki-as-Context for Claude Code

## How This Works

You maintain a wiki at `.composia/wiki/`. The wiki IS your context. You do not rely on chat history.

## At the START of every turn

1. Read `.composia/wiki/index.md`
2. Based on the user's message, read the relevant pages listed in the index
3. If you need more context, read additional pages via cross-references ([[links]])

The wiki is your memory. If it's not in the wiki, you don't know it.

## At the END of every turn

After responding to the user, update the wiki:

1. **Identify new knowledge** from both the user's input and your response — decisions, facts, concepts, corrections, questions resolved
2. **Create or update pages** in `.composia/wiki/pages/`:
   - One concept per page
   - Use YAML frontmatter: `title`, `tags`, `updated`
   - Add `[[cross-references]]` to related pages
   - If a concept already has a page, UPDATE it rather than creating a duplicate
3. **Update `.composia/wiki/index.md`** — keep the catalog current with one-line summaries
4. **Append to `.composia/wiki/log.md`** — short entry of what changed
5. **Tell the user**: "Wiki updated: [brief summary of changes]. Run /clear to start next turn with fresh context from wiki."

## Page format

```markdown
---
title: Page Title
tags: [tag1, tag2]
updated: 2026-04-07
---
# Page Title

Content here. Links to [[other-pages]] for cross-referencing.
```

## Rules

- One concept per page
- Every page has at least one [[cross-reference]]
- Never delete — mark as superseded with link to replacement
- Prefer updating existing pages over creating new ones
- If user corrects something, update the page and note the correction
- The index must always be current

## Every 10 turns (maintenance)

When the log shows ~10 updates since last maintenance:
- Check for contradictions between pages
- Find orphan pages with no inbound [[links]]
- Merge pages covering the same concept
- Flag stale information

## What the user does

After each turn, the user runs `/clear` to wipe chat history. The next turn starts fresh — you read the wiki to rebuild context. The wiki grows with every turn. Chat history is disposable. The wiki is the artifact.
