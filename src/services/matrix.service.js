import { engine } from '../dal/db.js';
import {
  LinkUnitsSchema,
  UnlinkUnitsSchema,
  MatrixEntrySchema,
  TargetsResponseSchema
} from '../models/matrix.model.js';

/**
 * Create a matrix instruction (link units)
 * @throws Error if namespace doesn't exist
 * @throws Error if verb requires verb_value but none provided
 */
export const linkUnits = (input) => {
  const validated = LinkUnitsSchema.parse(input);
  const { namespace, source, verb, target, order, verb_value } = validated;

  // Engine validates namespace exists
  engine.link_units(namespace, source, verb, target, order, verb_value || null);

  return {
    namespace,
    source,
    verb,
    target,
    order,
    verb_value: verb_value || null
  };
};

/**
 * Remove a matrix instruction (unlink units)
 * @returns true if deleted, false if not found
 */
export const unlinkUnits = (input) => {
  const { namespace, source, verb, target } = UnlinkUnitsSchema.parse(input);
  return engine.unlink_units(namespace, source, verb, target);
};

/**
 * Check if a matrix entry exists
 */
export const hasMatrixEntry = (namespace, source, verb, target) => {
  return engine.has_matrix_entry(namespace, source, verb, target);
};

/**
 * Get a single matrix entry
 * @returns {order, verb_value} or null if not found
 */
export const getMatrixEntry = (namespace, source, verb, target) => {
  return engine.get_matrix_entry(namespace, source, verb, target);
};

/**
 * Get all targets for a namespace:source:verb combination
 * Returns sorted by order
 */
export const getTargets = (namespace, source, verb) => {
  const raw = engine.get_targets(namespace, source, verb);
  return TargetsResponseSchema.parse(raw);
};

/**
 * Get matrix entries by prefix (for debugging/admin)
 */
export const getMatrixSegment = (prefix) => {
  return engine.get_matrix_segment(prefix);
};
