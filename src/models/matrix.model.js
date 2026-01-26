import { z } from 'zod';
import { NamespaceId } from './namespace.model.js';

/**
 * Unit ID - 32-char lowercase hex
 */
export const UnitId = z
  .string()
  .length(32)
  .regex(/^[a-f0-9]+$/, 'Unit ID must be 32 lowercase hex characters');

/**
 * Valid verb types for the instruction matrix
 */
export const VerbType = z.enum(['UNIT', 'HIDE', 'REPLACE', 'OVERLAY', 'MOUNT']);

/**
 * Link units request - create a matrix instruction
 */
export const LinkUnitsSchema = z.object({
  namespace: NamespaceId,
  source: UnitId,
  verb: VerbType,
  target: UnitId,
  order: z.number().default(0),
  verb_value: z.string().nullable().optional()
}).refine(
  (data) => {
    // REPLACE, OVERLAY, MOUNT require verb_value
    if (['REPLACE', 'OVERLAY', 'MOUNT'].includes(data.verb)) {
      return data.verb_value != null && data.verb_value.length > 0;
    }
    return true;
  },
  {
    message: 'verb_value is required for REPLACE, OVERLAY, and MOUNT verbs'
  }
);

/**
 * Unlink units request - remove a matrix instruction
 */
export const UnlinkUnitsSchema = z.object({
  namespace: NamespaceId,
  source: UnitId,
  verb: VerbType,
  target: UnitId
});

/**
 * Matrix entry response
 */
export const MatrixEntrySchema = z.object({
  namespace: z.string(),
  source: z.string(),
  verb: z.string(),
  target: z.string(),
  order: z.number(),
  verb_value: z.string().nullable()
});

/**
 * Get targets response
 */
export const TargetsResponseSchema = z.array(z.object({
  target: z.string(),
  order: z.number(),
  verb_value: z.string().nullable()
}));
