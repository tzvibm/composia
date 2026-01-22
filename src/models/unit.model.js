import { z } from 'zod';

/**
 * REUSABLE COMPONENTS
 * Centralized ID validation to ensure strict 32-char hex matching.
 */
const UnitId = z.string()
  .length(32, "ID must be exactly 32 characters")
  .regex(/^[a-f0-9]{32}$/i, "Must be a valid 32-character hexadecimal hash");

export const UnitSchema = z.object({
  id: UnitId,
  label: z.string().min(1),
  payload: z.record(z.any()),
  created_at: z.any()
});

/**
 * CREATE
 */
export const CreateRequestSchema = z.array(
  z.object({
    label: z.string().min(1),
    payload: z.record(z.any()).optional().default({})
  })
).min(1);

export const CreateResponseSchema = z.array(UnitSchema);

/**
 * READ
 */
export const ReadRequestSchema = z.preprocess((val) => {
  // If IDs come from query string (?ids=a,b), split them into an array
  if (typeof val === 'string') return val.split(',');
  return val;
}, z.array(UnitId).min(1));

export const ReadResponseSchema = z.array(UnitSchema);

/**
 * UPDATE (Labels/Generic)
 */
export const UpdateUnitsRequestSchema = z.array(
  z.object({
    id: UnitId,
    label: z.string().min(1).optional(),
  })
).min(1);

export const UpdateResponseSchema = z.array(UnitSchema);

/**
 * UPDATE (Payload Deep Merge)
 */
export const UpdatePayloadsRequestSchema = z.array(
  z.object({
    id: UnitId,
    payload: z.record(z.any()).default({})
  })
).min(1);

export const UpdatePayloadsResponseSchema = z.array(UnitSchema);

/**
 * DELETE
 */
export const DeleteUnitsRequestSchema = z.object({
  ids: z.array(UnitId).min(1)
});

export const DeleteUnitsResponseSchema = z.object({
  deleted: z.array(z.string()),
  count: z.number()
});