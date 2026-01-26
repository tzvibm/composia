import { z } from 'zod';
import { NamespaceId } from './namespace.model.js';
import { UnitId } from './matrix.model.js';

/**
 * Resolution request - resolve a unit hierarchy
 */
export const ResolveRequestSchema = z.object({
  namespace: NamespaceId,
  unit_id: UnitId,
  depth: z.number().int().min(0).max(10).default(2),
  width: z.number().int().min(1).max(100).default(10),
  offset: z.number().int().min(0).default(0),
  include_ops: z.boolean().default(false)
});

/**
 * Operation log entry - records what happened during resolution
 */
export const OperationSchema = z.object({
  step: z.number(),
  action: z.string(),
  details: z.record(z.any()).optional()
});

/**
 * Resolved unit in the hierarchy
 */
export const ResolvedUnitSchema = z.lazy(() => z.object({
  id: z.string(),
  original_id: z.string().optional(),
  label: z.string().optional(),
  payload: z.record(z.any()),
  children: z.array(ResolvedUnitSchema).default([])
}));

/**
 * Resolution response
 */
export const ResolveResponseSchema = z.object({
  hierarchy: ResolvedUnitSchema.nullable(),
  operations: z.array(OperationSchema).optional()
});
