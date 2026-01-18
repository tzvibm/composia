import { z } from 'zod';

export const CreateRequestSchema = z.array(
  z.object({
    label: z.string().min(1),
    payload: z.record(z.any()).optional().default({})
  })
);

export const UnitSchema = z.object({
  id: z.string().length(32),
  label: z.string().min(1),
  payload: z.record(z.any()),
  created_at: z.coerce.date()
});

export const CreateResponseSchema = z.array(UnitSchema);

export const ReadRequestSchema = z.preprocess((val) => {
  if (typeof val === 'string') return val.split(',');
  return val;
}, z.array(
     z.string()
      .length(32)
      .regex(/^[a-f0-9]+$/, "Must be a valid hexadecimal hash") // <--- ADD THIS
   ).min(1)
);

export const ReadResponseSchema = z.array(UnitSchema);


// Schema for updating unit properties
export const UpdateUnitsRequestSchema = z.array(
  z.object({
    id: z.string().length(32).regex(/^[a-f0-9]+$/i), // Must be Hash32
    label: z.string().min(1).optional(),            // Optional: only update if provided
    // Add future generic fields here (e.g., description: z.string().optional())
  })
).min(1);

export const UpdateResponseSchema = z.array(UnitSchema);