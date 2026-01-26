import { generateHash32 } from '../utils/id.js';
import { engine } from '../dal/db.js';
import {
  CreateRequestSchema,
  CreateResponseSchema,
  ReadRequestSchema,
  ReadResponseSchema,
  UpdateUnitsRequestSchema,
  UpdateResponseSchema,
  UpdatePayloadsRequestSchema,
  UpdatePayloadsResponseSchema,
  DeleteUnitsRequestSchema,
  DeleteUnitsResponseSchema
} from '../models/unit.model.js';

/**
 * Create new units with generated IDs
 */
export const createUnits = (userInput) => {
  const validatedInput = CreateRequestSchema.parse(userInput);

  const unitsToCreate = validatedInput.map(item => ({
    id: generateHash32(),
    label: item.label,
    payload: item.payload || {}
  }));

  const rawRows = engine.put_units(unitsToCreate);
  return CreateResponseSchema.parse(rawRows);
};

/**
 * Get units by IDs (supports comma-separated string or array)
 */
export const getUnitsByIds = (input) => {
  const validatedIds = ReadRequestSchema.parse(input);
  const rows = engine.get_units(validatedIds);
  return ReadResponseSchema.parse(rows);
};

/**
 * Update unit labels/metadata (shallow merge)
 */
export const updateUnits = (userInput) => {
  const validatedInput = UpdateUnitsRequestSchema.parse(userInput);
  const updatedRows = engine.update_units(validatedInput);
  return UpdateResponseSchema.parse(updatedRows);
};

/**
 * Update unit payloads (shallow merge into existing payload)
 */
export const updatePayloads = (userInput) => {
  const validatedInput = UpdatePayloadsRequestSchema.parse(userInput);

  // Rust update_units does shallow merge at top level
  // For payload merge, we need to structure it properly
  const updates = validatedInput.map(item => ({
    id: item.id,
    payload: item.payload
  }));

  const updatedRows = engine.update_units(updates);
  return UpdatePayloadsResponseSchema.parse(updatedRows);
};

/**
 * Delete units by IDs
 */
export const deleteUnits = (userInput) => {
  const { ids } = DeleteUnitsRequestSchema.parse(userInput);
  const deletedIds = engine.delete_units(ids);

  return DeleteUnitsResponseSchema.parse({
    deleted: deletedIds,
    count: deletedIds.length
  });
};
