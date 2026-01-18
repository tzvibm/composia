const unitsService = require('../services/units.service');

/**
 * Controller: Handle POST /units
 */
const createUnits = async (request, reply) => {
  try {
    // 1. Pass the raw body (array) to the Service Layer
    const result = await unitsService.createUnits(request.body);

    // 2. Respond with 201 Created and the enriched units
    return reply.code(201).send(result);
  } catch (error) {
    // 3. Handle Zod validation errors specifically
    if (error.name === 'ZodError') {
      return reply.code(400).send({
        error: 'Validation Failed',
        details: error.errors
      });
    }

    // 4. Generic error fallback
    request.log.error(error);
    return reply.code(500).send({ error: 'Internal Server Error' });
  }
};

module.exports = { createUnits };