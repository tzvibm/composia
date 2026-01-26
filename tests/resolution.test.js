import { describe, it, expect, beforeEach } from 'vitest';
import { engine, cleanDb } from '../src/dal/db.js';
import { resolveHierarchy } from '../src/services/resolution.service.js';

describe('Resolution Service - 8-Step Logic', () => {
  const NS = 'test_resolution';

  beforeEach(() => {
    cleanDb();
    engine.register_namespace(NS, { test: true });
  });

  // Helper to create proper 32-char hex IDs
  const makeId = (prefix) => {
    const hex = prefix.padEnd(32, '0');
    return hex.slice(0, 32);
  };

  // Helper to create test units
  const createUnit = (id, label, payload = {}) => {
    engine.put_units([{ id, label, payload }]);
  };

  // Helper to link units
  const link = (source, verb, target, order = 0, verbValue = null) => {
    engine.link_units(NS, source, verb, target, order, verbValue);
  };

  describe('Basic Resolution', () => {
    it('should resolve a single unit with no children', () => {
      const rootId = makeId('aaa');
      createUnit(rootId, 'Root Unit', { color: 'blue' });

      const result = resolveHierarchy({
        namespace: NS,
        unit_id: rootId
      });

      expect(result.hierarchy).not.toBeNull();
      expect(result.hierarchy.id).toBe(rootId);
      expect(result.hierarchy.label).toBe('Root Unit');
      expect(result.hierarchy.payload.color).toBe('blue');
      expect(result.hierarchy.children).toEqual([]);
    });

    it('should resolve a parent with children', () => {
      const parentId = makeId('bbb');
      const child1Id = makeId('ccc');
      const child2Id = makeId('ddd');

      createUnit(parentId, 'Parent', {});
      createUnit(child1Id, 'Child 1', { order: 1 });
      createUnit(child2Id, 'Child 2', { order: 2 });

      link(parentId, 'UNIT', child1Id, 1);
      link(parentId, 'UNIT', child2Id, 2);

      const result = resolveHierarchy({
        namespace: NS,
        unit_id: parentId
      });

      expect(result.hierarchy.children).toHaveLength(2);
      expect(result.hierarchy.children[0].label).toBe('Child 1');
      expect(result.hierarchy.children[1].label).toBe('Child 2');
    });

    it('should throw if namespace does not exist', () => {
      const anyId = makeId('eee');
      expect(() => {
        resolveHierarchy({
          namespace: 'nonexistent_namespace',
          unit_id: anyId
        });
      }).toThrow("Namespace 'nonexistent_namespace' not found");
    });

    it('should return null hierarchy if unit not found', () => {
      const missingId = makeId('fff');
      const result = resolveHierarchy({
        namespace: NS,
        unit_id: missingId
      });

      expect(result.hierarchy).toBeNull();
    });
  });

  describe('Step 2: Hide Check', () => {
    it('should hide unit when HIDE verb exists in namespace', () => {
      const visibleId = makeId('1a1');
      const hiddenId = makeId('1b1');

      createUnit(visibleId, 'Visible', {});
      createUnit(hiddenId, 'Hidden', {});

      link(visibleId, 'UNIT', hiddenId, 1);
      link(visibleId, 'HIDE', hiddenId, 0);

      const result = resolveHierarchy({
        namespace: NS,
        unit_id: visibleId
      });

      expect(result.hierarchy.children).toHaveLength(0);
    });

    it('should hide unit when HIDE verb exists in mount namespace', () => {
      const MOUNT_NS = 'mount_ns';
      engine.register_namespace(MOUNT_NS, {});

      const containerId = makeId('2a2');
      const widgetId = makeId('2b2');

      createUnit(containerId, 'Container', {});
      createUnit(widgetId, 'Widget', {});

      // Mount the widget with a mount namespace
      link(containerId, 'MOUNT', widgetId, 0, MOUNT_NS);
      link(containerId, 'UNIT', widgetId, 1);

      // Hide in mount namespace
      engine.link_units(MOUNT_NS, containerId, 'HIDE', widgetId, 0, null);

      const result = resolveHierarchy({
        namespace: NS,
        unit_id: containerId
      });

      expect(result.hierarchy.children).toHaveLength(0);
    });
  });

  describe('Step 3: Replacement Logic', () => {
    it('should replace unit when REPLACE verb exists', () => {
      const originalId = makeId('3a3');
      const replacementId = makeId('3b3');
      const parentId = makeId('3c3');

      createUnit(originalId, 'Original', { type: 'old' });
      createUnit(replacementId, 'Replacement', { type: 'new' });
      createUnit(parentId, 'Parent', {});

      link(parentId, 'UNIT', originalId, 1);
      link(parentId, 'REPLACE', originalId, 0, replacementId);

      const result = resolveHierarchy({
        namespace: NS,
        unit_id: parentId
      });

      expect(result.hierarchy.children).toHaveLength(1);
      expect(result.hierarchy.children[0].id).toBe(replacementId);
      expect(result.hierarchy.children[0].original_id).toBe(originalId);
      expect(result.hierarchy.children[0].payload.type).toBe('new');
    });

    it('should apply namespace replacement after mount replacement', () => {
      const MOUNT_NS = 'mount_replace_ns';
      engine.register_namespace(MOUNT_NS, {});

      const baseId = makeId('4a4');
      const mountReplId = makeId('4b4');
      const nsReplId = makeId('4c4');
      const containerId = makeId('4d4');

      createUnit(baseId, 'Base', {});
      createUnit(mountReplId, 'Mount Replacement', { from: 'mount' });
      createUnit(nsReplId, 'NS Replacement', { from: 'namespace' });
      createUnit(containerId, 'Container', {});

      link(containerId, 'MOUNT', baseId, 0, MOUNT_NS);
      link(containerId, 'UNIT', baseId, 1);

      // Mount namespace replaces to mount_repl
      engine.link_units(MOUNT_NS, containerId, 'REPLACE', baseId, 0, mountReplId);

      // Namespace replaces mount_repl to ns_repl (layered replacement)
      link(containerId, 'REPLACE', mountReplId, 0, nsReplId);

      const result = resolveHierarchy({
        namespace: NS,
        unit_id: containerId
      });

      expect(result.hierarchy.children[0].id).toBe(nsReplId);
      expect(result.hierarchy.children[0].payload.from).toBe('namespace');
    });
  });

  describe('Step 4 & 5: Overlay Merging', () => {
    it('should merge overlays in order (lowest first, highest overrides)', () => {
      const baseId = makeId('5a5');
      const overlay1Id = makeId('5b5');
      const overlay2Id = makeId('5c5');
      const parentId = makeId('5d5');

      createUnit(baseId, 'Base', { a: 1, b: 1 });
      createUnit(overlay1Id, 'Overlay 1', { b: 2, c: 2 });
      createUnit(overlay2Id, 'Overlay 2', { c: 3, d: 3 });
      createUnit(parentId, 'Parent', {});

      link(parentId, 'UNIT', baseId, 1);
      link(parentId, 'OVERLAY', baseId, 1, overlay1Id);
      link(parentId, 'OVERLAY', baseId, 2, overlay2Id);

      const result = resolveHierarchy({
        namespace: NS,
        unit_id: parentId
      });

      const payload = result.hierarchy.children[0].payload;
      expect(payload.a).toBe(1); // from base
      expect(payload.b).toBe(2); // overridden by overlay1
      expect(payload.c).toBe(3); // overridden by overlay2
      expect(payload.d).toBe(3); // from overlay2
    });

    it('should apply namespace overlays after mount overlays', () => {
      const MOUNT_NS = 'mount_overlay_ns';
      engine.register_namespace(MOUNT_NS, {});

      const baseId = makeId('6a6');
      const mountOvId = makeId('6b6');
      const nsOvId = makeId('6c6');
      const containerId = makeId('6d6');

      createUnit(baseId, 'Base', { source: 'base' });
      createUnit(mountOvId, 'Mount Overlay', { source: 'mount' });
      createUnit(nsOvId, 'NS Overlay', { source: 'namespace' });
      createUnit(containerId, 'Container', {});

      link(containerId, 'MOUNT', baseId, 0, MOUNT_NS);
      link(containerId, 'UNIT', baseId, 1);

      // Mount overlay
      engine.link_units(MOUNT_NS, containerId, 'OVERLAY', baseId, 1, mountOvId);

      // Namespace overlay (should override mount)
      link(containerId, 'OVERLAY', baseId, 1, nsOvId);

      const result = resolveHierarchy({
        namespace: NS,
        unit_id: containerId
      });

      expect(result.hierarchy.children[0].payload.source).toBe('namespace');
    });
  });

  describe('Step 7: Width and Depth Limits', () => {
    it('should respect width limit', () => {
      const parentId = makeId('7a7');
      createUnit(parentId, 'Parent', {});

      for (let i = 1; i <= 15; i++) {
        const childId = makeId(`7${i.toString(16).padStart(2, '0')}`);
        createUnit(childId, `Child ${i}`, {});
        link(parentId, 'UNIT', childId, i);
      }

      const result = resolveHierarchy({
        namespace: NS,
        unit_id: parentId,
        width: 5
      });

      expect(result.hierarchy.children).toHaveLength(5);
    });

    it('should respect depth limit', () => {
      const level0 = makeId('8a8');
      const level1 = makeId('8b8');
      const level2 = makeId('8c8');
      const level3 = makeId('8d8');

      createUnit(level0, 'Level 0', {});
      createUnit(level1, 'Level 1', {});
      createUnit(level2, 'Level 2', {});
      createUnit(level3, 'Level 3', {});

      link(level0, 'UNIT', level1, 1);
      link(level1, 'UNIT', level2, 1);
      link(level2, 'UNIT', level3, 1);

      const result = resolveHierarchy({
        namespace: NS,
        unit_id: level0,
        depth: 2
      });

      // Depth 0: level0 -> Depth 1: level1 -> Depth 2: level2 (no children due to limit)
      expect(result.hierarchy.children).toHaveLength(1);
      expect(result.hierarchy.children[0].children).toHaveLength(1);
      expect(result.hierarchy.children[0].children[0].children).toHaveLength(0);
    });

    it('should apply offset only to first level', () => {
      const parentId = makeId('9a9');
      createUnit(parentId, 'Parent', {});

      for (let i = 1; i <= 5; i++) {
        const childId = makeId(`9${i.toString(16)}9`);
        createUnit(childId, `Child ${i}`, {});
        link(parentId, 'UNIT', childId, i);
      }

      const result = resolveHierarchy({
        namespace: NS,
        unit_id: parentId,
        offset: 2 // Skip first 2 (order 1 and 2)
      });

      expect(result.hierarchy.children).toHaveLength(3);
      expect(result.hierarchy.children[0].label).toBe('Child 3');
    });
  });

  describe('Operation Logging', () => {
    it('should include operations when include_ops is true', () => {
      const loggedId = makeId('aa1');
      createUnit(loggedId, 'Logged Unit', {});

      const result = resolveHierarchy({
        namespace: NS,
        unit_id: loggedId,
        include_ops: true
      });

      expect(result.operations).toBeDefined();
      expect(result.operations.length).toBeGreaterThan(0);
      expect(result.operations[0].step).toBe(1);
      expect(result.operations[0].action).toBe('mount_check');
    });

    it('should not include operations when include_ops is false', () => {
      const notLoggedId = makeId('bb2');
      createUnit(notLoggedId, 'Not Logged', {});

      const result = resolveHierarchy({
        namespace: NS,
        unit_id: notLoggedId,
        include_ops: false
      });

      expect(result.operations).toBeUndefined();
    });
  });

  describe('Mount Namespace Context', () => {
    it('should check mount namespace for all verb types', () => {
      const MOUNT_NS = 'full_mount_ns';
      engine.register_namespace(MOUNT_NS, {});

      const mountedId = makeId('cc3');
      const mountedChildId = makeId('dd4');
      const rootId = makeId('ee5');

      createUnit(mountedId, 'Mounted Unit', { base: true });
      createUnit(mountedChildId, 'Mounted Child', {});
      createUnit(rootId, 'Root', {});

      // Root has a mounted unit
      link(rootId, 'MOUNT', mountedId, 0, MOUNT_NS);
      link(rootId, 'UNIT', mountedId, 1);

      // Child defined in mount namespace
      engine.link_units(MOUNT_NS, mountedId, 'UNIT', mountedChildId, 1, null);

      const result = resolveHierarchy({
        namespace: NS,
        unit_id: rootId,
        depth: 3
      });

      // Root -> mounted unit -> mounted child (from mount namespace)
      expect(result.hierarchy.children).toHaveLength(1);
      expect(result.hierarchy.children[0].children).toHaveLength(1);
      expect(result.hierarchy.children[0].children[0].label).toBe('Mounted Child');
    });
  });
});
