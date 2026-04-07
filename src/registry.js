/**
 * Mapper Registry — discovers and selects domain-specific mappers.
 *
 * Mappers are MD files in .composia/mappers/ with frontmatter describing
 * what content they handle. The registry reads them, matches against input,
 * and returns applicable mapper node IDs.
 *
 * This is the foundation for the open-source mapper marketplace —
 * anyone can create a mapper MD file and share it.
 */

import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { parseFrontmatter } from './parser.js';

const MAPPERS_DIR = '.composia/mappers';

/**
 * Load all mapper definitions from .composia/mappers/
 * @param {string} baseDir - Project root
 * @returns {Array<{ id, domain, filePatterns, contentPatterns, meta }>}
 */
export function loadMappers(baseDir = process.cwd()) {
  const dir = path.join(baseDir, MAPPERS_DIR);
  if (!existsSync(dir)) return [];

  const mappers = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.md')) continue;
    try {
      const content = readFileSync(path.join(dir, file), 'utf-8');
      const { properties } = parseFrontmatter(content);
      mappers.push({
        id: properties.id || file.replace(/\.md$/, ''),
        domain: properties.domain || 'generic',
        filePatterns: properties.file_patterns || [],
        contentPatterns: properties.content_patterns || [],
        description: properties.description || '',
        file,
        content,
      });
    } catch { /* skip malformed mapper files */ }
  }
  return mappers;
}

/**
 * Select mappers that match given content or file paths.
 * @param {string} baseDir - Project root
 * @param {object} input - { content?, filePaths?, domain? }
 * @returns {Array} matching mapper definitions
 */
export function selectMappers(baseDir, input = {}) {
  const mappers = loadMappers(baseDir);
  if (mappers.length === 0) return [];

  // If domain specified, filter directly
  if (input.domain) {
    return mappers.filter(m => m.domain === input.domain);
  }

  const matched = [];
  for (const mapper of mappers) {
    let score = 0;

    // Match file patterns (globs like "*.js", "*.py")
    if (input.filePaths?.length && mapper.filePatterns.length) {
      for (const fp of input.filePaths) {
        for (const pattern of mapper.filePatterns) {
          if (fp.endsWith(pattern.replace('*', '')) || fp.match(globToRegex(pattern))) {
            score += 2;
          }
        }
      }
    }

    // Match content patterns (keywords in content)
    if (input.content && mapper.contentPatterns.length) {
      const lower = input.content.toLowerCase();
      for (const pattern of mapper.contentPatterns) {
        if (lower.includes(pattern.toLowerCase())) {
          score += 1;
        }
      }
    }

    if (score > 0) {
      matched.push({ ...mapper, score });
    }
  }

  return matched.sort((a, b) => b.score - a.score);
}

/**
 * Install a mapper MD file into .composia/mappers/
 * @param {string} baseDir - Project root
 * @param {string} source - File path or content of the mapper MD
 * @param {string} filename - Target filename (e.g. "legal-contracts.md")
 */
export function installMapper(baseDir, source, filename) {
  const dir = path.join(baseDir, MAPPERS_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  let content;
  if (existsSync(source)) {
    content = readFileSync(source, 'utf-8');
  } else {
    content = source; // treat as raw content
  }

  const target = path.join(dir, filename);
  writeFileSync(target, content, 'utf-8');
  return { installed: filename, path: target };
}

function globToRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(escaped);
}
