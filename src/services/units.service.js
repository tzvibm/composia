const { generateHash32 } = require('../utils/id');
const { CreateRequestSchema, CreateResponseSchema } = require('../models/unit.model');
const unitsRepo = require('../dal/units.repository');

const createUnits = async (userInput) => {
  // 1. INBOUND: Validate raw user input
  const validatedInput = CreateRequestSchema.parse(userInput);

  // 2. TRANSFORM: Inject IDs for the DAL
  const unitsToCreate = validatedInput.map(item => ({
    id: generateHash32(), 
    label: item.label,
    payload: item.payload
  }));

  // 3. DAL: Execute the INSERT and get raw rows back
  const rawRows = await unitsRepo.createUnits(unitsToCreate);

  // 4. OUTBOUND: Validate/Clean the DB rows against the Response Model
  // This ensures created_at and ids are formatted correctly for the user
  return CreateResponseSchema.parse(rawRows);
};

module.exports = { createUnits };