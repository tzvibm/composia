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
 * Parse YAML frontmatter from markdown content.
 * Returns { properties: {}, body: string }
 *
 * Supports:
 *   ---
 *   title: My Note
 *   tags: [rust, js]
 *   date: 2024-01-01
 *   custom_field: value
 *   ---
 *   # Content here
 */
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

export function parseFrontmatter(content) {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return { properties: {}, body: content };

  const yaml = match[1];
  const body = content.slice(match[0].length);
  const properties = {};

  for (const line of yaml.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();

    if (!key) continue;

    // Parse arrays: [a, b, c]
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map(v => v.trim().replace(/^["']|["']$/g, ''));
    }
    // Parse booleans
    else if (value === 'true') value = true;
    else if (value === 'false') value = false;
    // Parse numbers
    else if (/^-?\d+(\.\d+)?$/.test(value)) value = Number(value);
    // Strip quotes
    else value = value.replace(/^["']|["']$/g, '');

    properties[key] = value;
  }

  return { properties, body };
}

/**
 * Serialize properties back to YAML frontmatter string.
 */
export function serializeFrontmatter(properties) {
  if (!properties || Object.keys(properties).length === 0) return '';

  const lines = ['---'];
  for (const [key, value] of Object.entries(properties)) {
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.join(', ')}]`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push('---', '');
  return lines.join('\n');
}

/**
 * Apply a template string, replacing {{variable}} placeholders.
 *
 * Supports:
 *   {{title}}        — simple variable
 *   {{date}}         — current ISO date
 *   {{time}}         — current ISO time
 *   {{timestamp}}    — full ISO timestamp
 *   {{id}}           — slugified title
 *
 * @param {string} template - Template string with {{placeholders}}
 * @param {object} vars - Variables to substitute
 * @returns {string}
 */
export function applyTemplate(template, vars = {}) {
  const now = new Date();
  const builtins = {
    date: now.toISOString().slice(0, 10),
    time: now.toISOString().slice(11, 19),
    timestamp: now.toISOString(),
    id: vars.title ? slugify(vars.title) : '',
    ...vars,
  };

  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    return builtins[key] !== undefined ? String(builtins[key]) : `{{${key}}}`;
  });
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
