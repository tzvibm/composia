/**
 * Parse [[wikilinks]] from markdown content.
 *
 * Supports:
 *   [[note-id]]
 *   [[note-id|display text]]
 *   [[note-id#heading]]
 *   [[note-id#heading|display text]]
 *
 * Returns array of { target, display, heading, raw }
 */
const WIKILINK_RE = /\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g;

export function parseLinks(content) {
  const links = [];
  let match;
  while ((match = WIKILINK_RE.exec(content)) !== null) {
    const target = match[1].trim();
    const heading = match[2]?.trim() || null;
    const display = match[3]?.trim() || null;
    links.push({ target, heading, display, raw: match[0] });
  }
  return links;
}

/**
 * Extract #tags from markdown content.
 * Matches #tag-name at word boundaries (not inside links or headings).
 */
const TAG_RE = /(?:^|\s)#([a-zA-Z][a-zA-Z0-9_-]*)/g;

export function parseTags(content) {
  const tags = new Set();
  let match;
  while ((match = TAG_RE.exec(content)) !== null) {
    tags.add(match[1].toLowerCase());
  }
  return [...tags];
}

/**
 * Generate a slug-style ID from a title.
 * "My Cool Note!" → "my-cool-note"
 */
export function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
