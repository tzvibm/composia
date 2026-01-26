import { describe, it, expect, beforeEach } from 'vitest';
import { engine, cleanDb } from '../src/dal/db.js';

describe('Composia Engine - Rust LMDB Layer', () => {
  beforeEach(() => {
    cleanDb();
  });

  // ==================== NAMESPACE OPERATIONS ====================

  describe('Namespace Operations', () => {
    it('should register a new namespace', () => {
      engine.register_namespace('test_ns', { owner: 'user_1', created: Date.now() });

      const exists = engine.namespace_exists('test_ns');
      expect(exists).toBe(true);
    });

    it('should fail to register duplicate namespace', () => {
      engine.register_namespace('dup_ns', {});

      expect(() => {
        engine.register_namespace('dup_ns', {});
      }).toThrow("Namespace 'dup_ns' already exists");
    });

    it('should get namespace metadata', () => {
      const metadata = { owner: 'alice', type: 'dashboard' };
      engine.register_namespace('meta_ns', metadata);

      const result = engine.get_namespace('meta_ns');
      expect(result).toEqual(metadata);
    });

    it('should return null for non-existent namespace', () => {
      const result = engine.get_namespace('nonexistent');
      expect(result).toBeNull();
    });

    it('should list all namespaces', () => {
      engine.register_namespace('ns_a', { label: 'A' });
      engine.register_namespace('ns_b', { label: 'B' });

      const list = engine.list_namespaces();
      expect(list).toHaveLength(2);
      expect(list.map(n => n.id).sort()).toEqual(['ns_a', 'ns_b']);
    });

    it('should delete a namespace', () => {
      engine.register_namespace('to_delete', {});
      expect(engine.namespace_exists('to_delete')).toBe(true);

      const deleted = engine.delete_namespace('to_delete');
      expect(deleted).toBe(true);
      expect(engine.namespace_exists('to_delete')).toBe(false);
    });
  });

  // ==================== UNIT OPERATIONS ====================

  describe('Unit Operations', () => {
    it('should put and get units', () => {
      const units = [
        { id: 'unit_001', label: 'First', payload: { color: 'red' } },
        { id: 'unit_002', label: 'Second', payload: { color: 'blue' } }
      ];

      engine.put_units(units);

      const result = engine.get_units(['unit_001', 'unit_002']);
      expect(result).toHaveLength(2);
      expect(result[0].label).toBe('First');
      expect(result[1].payload.color).toBe('blue');
    });

    it('should return empty array for non-existent units', () => {
      const result = engine.get_units(['nonexistent_id']);
      expect(result).toEqual([]);
    });

    it('should update existing units', () => {
      engine.put_units([{ id: 'upd_001', label: 'Original', payload: { x: 1 } }]);

      const updated = engine.update_units([{ id: 'upd_001', label: 'Updated', payload: { x: 2, y: 3 } }]);

      expect(updated[0].label).toBe('Updated');
      expect(updated[0].payload).toEqual({ x: 2, y: 3 });

      // Verify persisted
      const fetched = engine.get_units(['upd_001']);
      expect(fetched[0].label).toBe('Updated');
    });

    it('should fail to update non-existent unit', () => {
      expect(() => {
        engine.update_units([{ id: 'ghost', label: 'Nope' }]);
      }).toThrow("Unit 'ghost' not found");
    });

    it('should delete units', () => {
      engine.put_units([
        { id: 'del_001', label: 'A' },
        { id: 'del_002', label: 'B' }
      ]);

      const deleted = engine.delete_units(['del_001', 'del_003']); // del_003 doesn't exist
      expect(deleted).toEqual(['del_001']);

      const remaining = engine.get_units(['del_001', 'del_002']);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe('del_002');
    });
  });

  // ==================== MATRIX OPERATIONS ====================

  describe('Matrix Operations', () => {
    const NS = 'matrix_test_ns';

    beforeEach(() => {
      engine.register_namespace(NS, {});
    });

    it('should require namespace to exist before linking', () => {
      expect(() => {
        engine.link_units('fake_ns', 'src', 'UNIT', 'tgt', 1, null);
      }).toThrow("Namespace 'fake_ns' not registered");
    });

    it('should link units with verb and order', () => {
      engine.link_units(NS, 'parent', 'UNIT', 'child_1', 1, null);
      engine.link_units(NS, 'parent', 'UNIT', 'child_2', 2, null);

      const targets = engine.get_targets(NS, 'parent', 'UNIT');
      expect(targets).toHaveLength(2);
      expect(targets[0].target).toBe('child_1');
      expect(targets[0].order).toBe(1);
      expect(targets[1].target).toBe('child_2');
      expect(targets[1].order).toBe(2);
    });

    it('should store and retrieve verb_value', () => {
      // REPLACE verb with replacement unit ID
      engine.link_units(NS, 'src', 'REPLACE', 'original', 1, 'replacement_unit');

      const entry = engine.get_matrix_entry(NS, 'src', 'REPLACE', 'original');
      expect(entry).not.toBeNull();
      expect(entry.verb_value).toBe('replacement_unit');
      expect(entry.order).toBe(1);
    });

    it('should check if matrix entry exists', () => {
      engine.link_units(NS, 'a', 'HIDE', 'b', 1, null);

      expect(engine.has_matrix_entry(NS, 'a', 'HIDE', 'b')).toBe(true);
      expect(engine.has_matrix_entry(NS, 'a', 'HIDE', 'c')).toBe(false);
      expect(engine.has_matrix_entry(NS, 'a', 'UNIT', 'b')).toBe(false);
    });

    it('should get single matrix entry', () => {
      engine.link_units(NS, 'x', 'OVERLAY', 'y', 5, 'overlay_unit');

      const entry = engine.get_matrix_entry(NS, 'x', 'OVERLAY', 'y');
      expect(entry).toEqual({ order: 5, verb_value: 'overlay_unit' });

      const missing = engine.get_matrix_entry(NS, 'x', 'OVERLAY', 'z');
      expect(missing).toBeNull();
    });

    it('should return targets sorted by order', () => {
      engine.link_units(NS, 'root', 'UNIT', 'c', 3, null);
      engine.link_units(NS, 'root', 'UNIT', 'a', 1, null);
      engine.link_units(NS, 'root', 'UNIT', 'b', 2, null);

      const targets = engine.get_targets(NS, 'root', 'UNIT');
      expect(targets.map(t => t.target)).toEqual(['a', 'b', 'c']);
    });

    it('should unlink units', () => {
      engine.link_units(NS, 'p', 'UNIT', 'q', 1, null);
      expect(engine.has_matrix_entry(NS, 'p', 'UNIT', 'q')).toBe(true);

      const deleted = engine.unlink_units(NS, 'p', 'UNIT', 'q');
      expect(deleted).toBe(true);
      expect(engine.has_matrix_entry(NS, 'p', 'UNIT', 'q')).toBe(false);
    });

    it('should get matrix segment by prefix', () => {
      engine.link_units(NS, 'src', 'UNIT', 't1', 1, null);
      engine.link_units(NS, 'src', 'UNIT', 't2', 2, null);
      engine.link_units(NS, 'src', 'HIDE', 't3', 1, null);
      engine.link_units(NS, 'other', 'UNIT', 't4', 1, null);

      // Query all entries for NS:src
      const segment = engine.get_matrix_segment(`${NS}:src:`);
      expect(segment).toHaveLength(3);
      expect(segment.map(e => e.verb).sort()).toEqual(['HIDE', 'UNIT', 'UNIT']);
    });

    it('should support MOUNT verb with namespace in verb_value', () => {
      const mountNs = 'mounted_ns';
      engine.register_namespace(mountNs, { type: 'mounted' });

      engine.link_units(NS, 'container', 'MOUNT', 'widget', 1, mountNs);

      const entry = engine.get_matrix_entry(NS, 'container', 'MOUNT', 'widget');
      expect(entry.verb_value).toBe(mountNs);
    });
  });

  // ==================== DATABASE OPERATIONS ====================

  describe('Database Operations', () => {
    it('should clear all databases', () => {
      // Add data to all three databases
      engine.register_namespace('clear_ns', {});
      engine.put_units([{ id: 'clear_unit', label: 'Test' }]);
      engine.link_units('clear_ns', 's', 'UNIT', 't', 1, null);

      // Verify data exists
      expect(engine.namespace_exists('clear_ns')).toBe(true);
      expect(engine.get_units(['clear_unit'])).toHaveLength(1);
      expect(engine.has_matrix_entry('clear_ns', 's', 'UNIT', 't')).toBe(true);

      // Clear
      engine.clear_db();

      // Verify all cleared
      expect(engine.namespace_exists('clear_ns')).toBe(false);
      expect(engine.get_units(['clear_unit'])).toHaveLength(0);
      expect(engine.list_namespaces()).toHaveLength(0);
    });
  });
});
