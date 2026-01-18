const { z } = require('zod');

/**
 * #44 Create Units Request (Input)
 */
const CreateRequestSchema = z.array(
  z.object({
    label: z.string().min(1),
    payload: z.record(z.any()).optional().default({})
  })
);

/**
 * #44 Create Units Response (Output/Unit Model)
 * Validates what comes back from the DAL (RETURNING *)
 */
const UnitSchema = z.object({
  id: z.string().length(32),
  label: z.string().min(1),
  payload: z.record(z.any()),
  created_at: z.coerce.date() // Converts DB timestamp to Date/ISO string
});

const CreateResponseSchema = z.array(UnitSchema);

module.exports = { 
  CreateRequestSchema, 
  UnitSchema, 
  CreateResponseSchema 
};