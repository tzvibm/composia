import { engine } from '../dal/db.js';
import { ResolveRequestSchema } from '../models/resolution.model.js';

// Load limits from environment (with defaults)
// Higher defaults for testing; set lower in production via env vars
const MAX_DEPTH = parseInt(process.env.MAX_DEPTH || '10', 10);
const MAX_WIDTH = parseInt(process.env.MAX_WIDTH || '10', 10);
const MAX_OVERLAYS = parseInt(process.env.MAX_OVERLAYS || '5', 10);

/**
 * Deep merge two objects (target values override source)
 */
function deepMerge(source, target) {
  const result = { ...source };
  for (const key of Object.keys(target)) {
    if (
      target[key] !== null &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key]) &&
      source[key] !== null &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key])
    ) {
      result[key] = deepMerge(source[key], target[key]);
    } else {
      result[key] = target[key];
    }
  }
  return result;
}

/**
 * Resolve a unit hierarchy starting from a root unit
 *
 * @param {Object} input - Resolution request
 * @param {string} input.namespace - The namespace to resolve within
 * @param {string} input.unit_id - The root unit ID
 * @param {number} input.depth - Max recursion depth (capped by MAX_DEPTH)
 * @param {number} input.width - Max children per node (capped by MAX_WIDTH)
 * @param {number} input.offset - Offset for pagination (first level only)
 * @param {boolean} input.include_ops - Include operation log in response
 *
 * @returns {Object} { hierarchy, operations? }
 */
export const resolveHierarchy = (input) => {
  const validated = ResolveRequestSchema.parse(input);
  const {
    namespace,
    unit_id,
    depth,
    width,
    offset,
    include_ops
  } = validated;

  // Validate namespace exists
  if (!engine.namespace_exists(namespace)) {
    throw new Error(`Namespace '${namespace}' not found`);
  }

  // Cap limits to system maximums
  const maxDepth = Math.min(depth, MAX_DEPTH);
  const maxWidth = Math.min(width, MAX_WIDTH);

  const operations = [];

  // Start resolution from root (source === target for root)
  const result = resolveUnitCycle(
    namespace,
    unit_id,  // source
    unit_id,  // target (same for root)
    0,        // current depth
    {
      maxDepth,
      maxWidth,
      offset,
      operations,
      isFirstLevel: true
    }
  );

  return {
    hierarchy: result,
    ...(include_ops ? { operations } : {})
  };
};

/**
 * Internal: Resolve a single unit through the 8-step cycle
 *
 * @param {string} namespace - Request namespace
 * @param {string} sourceId - Parent unit ID (or self for root)
 * @param {string} targetId - Unit ID to resolve
 * @param {number} currentDepth - Current recursion depth
 * @param {Object} options - Resolution options
 */
function resolveUnitCycle(namespace, sourceId, targetId, currentDepth, options) {
  const { maxDepth, maxWidth, offset, operations, isFirstLevel } = options;

  // ========== STEP 1: Mount Check ==========
  // Check if this unit has a MOUNT verb (carries its own namespace)
  const mountEntry = engine.get_matrix_entry(namespace, sourceId, 'MOUNT', targetId);
  const mountNs = mountEntry?.verb_value || null;

  operations.push({
    step: 1,
    action: 'mount_check',
    details: { sourceId, targetId, mountNs }
  });

  // ========== STEP 2: Hide Check ==========
  // Check both namespaces for HIDE instruction
  const hiddenInNs = engine.has_matrix_entry(namespace, sourceId, 'HIDE', targetId);
  const hiddenInMount = mountNs && engine.has_matrix_entry(mountNs, sourceId, 'HIDE', targetId);

  if (hiddenInNs || hiddenInMount) {
    operations.push({
      step: 2,
      action: 'hidden',
      details: { targetId, by: hiddenInMount ? 'mount' : 'namespace' }
    });
    return null; // Unit is hidden
  }

  operations.push({
    step: 2,
    action: 'visible',
    details: { targetId }
  });

  // ========== STEP 3: Replacement Logic ==========
  let effectiveId = targetId;

  // 3a: Check mount namespace first (if mounted)
  if (mountNs) {
    const mountReplace = engine.get_matrix_entry(mountNs, sourceId, 'REPLACE', effectiveId);
    if (mountReplace?.verb_value) {
      const prevId = effectiveId;
      effectiveId = mountReplace.verb_value;
      operations.push({
        step: 3,
        action: 'replace_mount',
        details: { from: prevId, to: effectiveId, mountNs }
      });
    }
  }

  // 3b: Check request namespace (can override mount replacement)
  const nsReplace = engine.get_matrix_entry(namespace, sourceId, 'REPLACE', effectiveId);
  if (nsReplace?.verb_value) {
    const prevId = effectiveId;
    effectiveId = nsReplace.verb_value;
    operations.push({
      step: 3,
      action: 'replace_namespace',
      details: { from: prevId, to: effectiveId, namespace }
    });
  }

  if (effectiveId === targetId) {
    operations.push({
      step: 3,
      action: 'no_replacement',
      details: { targetId }
    });
  }

  // ========== STEP 4: Overlay Retrieval ==========
  // Get overlays from both namespaces, filtered to current target
  const mountOverlaysRaw = mountNs
    ? engine.get_targets(mountNs, sourceId, 'OVERLAY')
    : [];
  const nsOverlaysRaw = engine.get_targets(namespace, sourceId, 'OVERLAY');

  // Filter to only overlays for this specific target
  const mountOverlays = mountOverlaysRaw.filter(o => o.target === targetId);
  const nsOverlays = nsOverlaysRaw.filter(o => o.target === targetId);

  operations.push({
    step: 4,
    action: 'overlays_found',
    details: {
      mount_count: mountOverlays.length,
      namespace_count: nsOverlays.length
    }
  });

  // Fetch base unit
  const baseUnits = engine.get_units([effectiveId]);
  if (!baseUnits || baseUnits.length === 0) {
    operations.push({
      step: 4,
      action: 'unit_not_found',
      details: { effectiveId }
    });
    return null;
  }

  const baseUnit = baseUnits[0];

  // ========== STEP 5: Merge Priority ==========
  let payload = { ...(baseUnit.payload || {}) };

  // 5a: Merge mount overlays first (lowest order first, highest wins)
  const sortedMountOverlays = [...mountOverlays]
    .sort((a, b) => a.order - b.order)
    .slice(0, MAX_OVERLAYS);

  for (const overlay of sortedMountOverlays) {
    if (overlay.verb_value) {
      const [overlayUnit] = engine.get_units([overlay.verb_value]);
      if (overlayUnit?.payload) {
        payload = deepMerge(payload, overlayUnit.payload);
      }
    }
  }

  // 5b: Merge namespace overlays (lowest order first, highest wins, overrides mount)
  const sortedNsOverlays = [...nsOverlays]
    .sort((a, b) => a.order - b.order)
    .slice(0, MAX_OVERLAYS);

  for (const overlay of sortedNsOverlays) {
    if (overlay.verb_value) {
      const [overlayUnit] = engine.get_units([overlay.verb_value]);
      if (overlayUnit?.payload) {
        payload = deepMerge(payload, overlayUnit.payload);
      }
    }
  }

  operations.push({
    step: 5,
    action: 'merged',
    details: {
      mount_overlays_applied: sortedMountOverlays.length,
      namespace_overlays_applied: sortedNsOverlays.length
    }
  });

  // ========== STEP 6: Structure Update ==========
  const finalUnit = {
    id: effectiveId,
    ...(effectiveId !== targetId ? { original_id: targetId } : {}),
    label: baseUnit.label,
    payload,
    children: []
  };

  operations.push({
    step: 6,
    action: 'structure_updated',
    details: { id: effectiveId, original_id: targetId !== effectiveId ? targetId : null }
  });

  // ========== STEP 7: Width Limitation (Recursion Prep) ==========
  if (currentDepth >= maxDepth) {
    operations.push({
      step: 7,
      action: 'depth_limit_reached',
      details: { currentDepth, maxDepth }
    });
    return finalUnit;
  }

  // Get member units (UNIT verb) from namespace
  let members = engine.get_targets(namespace, effectiveId, 'UNIT');

  // Also get members from mount namespace if mounted
  if (mountNs) {
    const mountMembers = engine.get_targets(mountNs, effectiveId, 'UNIT');
    // Merge and dedupe by target (namespace takes priority)
    const seenTargets = new Set(members.map(m => m.target));
    for (const mm of mountMembers) {
      if (!seenTargets.has(mm.target)) {
        members.push(mm);
      }
    }
    // Re-sort by order
    members.sort((a, b) => a.order - b.order);
  }

  // Apply offset (only on first level)
  if (isFirstLevel && offset > 0) {
    members = members.filter(m => m.order > offset);
  }

  // Apply width limit
  members = members.slice(0, maxWidth);

  operations.push({
    step: 7,
    action: 'members_resolved',
    details: {
      count: members.length,
      offset_applied: isFirstLevel && offset > 0
    }
  });

  // ========== STEP 8: Recurse ==========
  for (const member of members) {
    const childResult = resolveUnitCycle(
      namespace,
      effectiveId,      // source = current unit
      member.target,    // target = child unit
      currentDepth + 1,
      {
        maxDepth,
        maxWidth,
        offset: 0, // offset only applies to first level
        operations,
        isFirstLevel: false
      }
    );

    if (childResult !== null) {
      finalUnit.children.push(childResult);
    }
  }

  operations.push({
    step: 8,
    action: 'recursion_complete',
    details: {
      unit_id: effectiveId,
      children_count: finalUnit.children.length
    }
  });

  return finalUnit;
}
