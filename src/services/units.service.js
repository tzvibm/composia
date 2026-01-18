import { generateHash32 } from '../utils/id.js';
import { 
  CreateRequestSchema, 
  CreateResponseSchema, 
  ReadRequestSchema, 
  ReadResponseSchema, 
  UpdateUnitsRequestSchema, 
  UpdateResponseSchema 
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