import { generateHash32 } from '../utils/id.js';
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
import * as unitsRepo from '../dal/units.repository.js';

export const createUnits = async (userInput) => {
  const validatedInput = CreateRequestSchema.parse(userInput);

  const unitsToCreate = validatedInput.map(item => ({
    id: generateHash32(), 
    label: item.label,
    payload: item.payload
  }));

  const rawRows = await unitsRepo.createUnits(unitsToCreate);
  return CreateResponseSchema.parse(rawRows);
};


export const getUnitsByIds = async (input) => {
  // Zod now handles the .split(',') internally via preprocess!
  const validatedIds = ReadRequestSchema.parse(input);

  const rows = await unitsRepo.readUnits(validatedIds);
  return ReadResponseSchema.parse(rows);
};


export const updateUnits = async (userInput) => {
  const validatedInput = UpdateUnitsRequestSchema.parse(userInput);
  
  const updatedRows = await unitsRepo.updateUnits(validatedInput);

  // Validate the rows coming back from the DB to ensure they match our Unit model
  return UpdateResponseSchema.parse(updatedRows);
};


export const updatePayloads = async (userInput) => {
  // 1. Validate the merge request
  const validatedInput = UpdatePayloadsRequestSchema.parse(userInput);

  // 2. Execute the JSONB merge in DAL
  const updatedRows = await unitsRepo.updatePayloads(validatedInput);

  // 3. Return the fully updated units
  return UpdatePayloadsResponseSchema.parse(updatedRows);
};


export const deleteUnits = async (userInput) => {
  // 1. Validate the list of IDs
  const { ids } = DeleteUnitsRequestSchema.parse(userInput);

  // 2. Execute deletion
  const result = await unitsRepo.deleteBatch(ids);

  // 3. Return validated response
  return DeleteUnitsResponseSchema.parse(result);
};