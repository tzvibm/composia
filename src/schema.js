/**
 * Composia Schema — field definitions, aliases, and validation.
 *
 * Prevents schema drift by:
 * 1. Defining known fields with types and allowed values
 * 2. Normalizing aliases (state → status, Status → status)
 * 3. Warning on unknown fields (not blocking — agents need flexibility)
 *
 * Schema is stored in .composia/schema.json and loaded on engine init.
 *
 * Example schema.json:
 * {
 *   "fields": {
 *     "status": {
 *       "type": "enum",
 *       "values": ["draft", "active", "blocked", "done", "archived"],
 *       "aliases": ["state", "State", "Status"]
 *     },
 *     "priority": {
 *       "type": "enum",
 *       "values": ["low", "medium", "high", "critical"],
 *       "aliases": ["Priority", "prio"]
 *     },
 *     "assignee": {
 *       "type": "string",
 *       "aliases": ["owner", "assigned_to"]
 *     }
 *   }
 * }
 */

import { readFileSync, existsSync, writeFileSync } from 'fs';
import path from 'path';

export class Schema {
  constructor(schemaPath) {
    this.schemaPath = schemaPath;
    this.fields = {};
    this._aliasMap = {}; // alias → canonical field name
  }

  load() {
    if (!existsSync(this.schemaPath)) return this;

    try {
      const data = JSON.parse(readFileSync(this.schemaPath, 'utf-8'));
      this.fields = data.fields || {};

      // Build alias map
      this._aliasMap = {};
      for (const [canonical, def] of Object.entries(this.fields)) {
        // Canonical name maps to itself
        this._aliasMap[canonical] = canonical;
        this._aliasMap[canonical.toLowerCase()] = canonical;
        // Aliases map to canonical
        for (const alias of (def.aliases || [])) {
          this._aliasMap[alias] = canonical;
          this._aliasMap[alias.toLowerCase()] = canonical;
        }
      }
    } catch {
      // Invalid schema file — proceed without schema
    }

    return this;
  }

  /**
   * Normalize property keys using alias map.
   * { State: "blocked", prio: "high" } → { status: "blocked", priority: "high" }
   */
  normalizeProperties(properties) {
    if (!properties || Object.keys(this._aliasMap).length === 0) return properties;

    const normalized = {};
    const warnings = [];

    for (const [key, value] of Object.entries(properties)) {
      const canonical = this._aliasMap[key] || this._aliasMap[key.toLowerCase()];

      if (canonical) {
        // Validate enum values
        const fieldDef = this.fields[canonical];
        if (fieldDef?.type === 'enum' && fieldDef.values) {
          const strVal = String(value).toLowerCase();
          const matched = fieldDef.values.find(v => v.toLowerCase() === strVal);
          if (matched) {
            normalized[canonical] = matched;
          } else {
            warnings.push(`${canonical}: "${value}" not in [${fieldDef.values.join(', ')}]`);
            normalized[canonical] = value; // Store anyway, just warn
          }
        } else {
          normalized[canonical] = value;
        }
      } else {
        // Unknown field — pass through (agents need flexibility)
        normalized[key] = value;
      }
    }

    return { properties: normalized, warnings };
  }

  /**
   * Generate a default schema from existing notes.
   * Scans all property keys and values, suggests field definitions.
   */
  static async generateFromNotes(engine) {
    const fieldStats = {}; // field → { values: Set, count: number }

    for await (const [, note] of engine.notes.iterator()) {
      if (!note.properties) continue;
      for (const [key, value] of Object.entries(note.properties)) {
        if (!fieldStats[key]) fieldStats[key] = { values: new Set(), count: 0 };
        fieldStats[key].values.add(String(value));
        fieldStats[key].count++;
      }
    }

    const fields = {};
    for (const [key, stats] of Object.entries(fieldStats)) {
      const values = [...stats.values];
      if (values.length <= 20 && stats.count >= 2) {
        // Looks like an enum
        fields[key] = { type: 'enum', values, aliases: [] };
      } else {
        fields[key] = { type: 'string', aliases: [] };
      }
    }

    // Detect potential aliases (fields with similar names)
    const keys = Object.keys(fields);
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        if (keys[i].toLowerCase() === keys[j].toLowerCase()) {
          // Same name different case — merge
          const keep = keys[i].length <= keys[j].length ? keys[i] : keys[j];
          const drop = keep === keys[i] ? keys[j] : keys[i];
          if (!fields[keep].aliases) fields[keep].aliases = [];
          fields[keep].aliases.push(drop);
          delete fields[drop];
        }
      }
    }

    return { fields };
  }
}

/**
 * Load schema from the project's .composia/ directory.
 */
export function loadSchema(projectDir = process.cwd()) {
  const schemaPath = path.join(projectDir, '.composia', 'schema.json');
  return new Schema(schemaPath).load();
}
