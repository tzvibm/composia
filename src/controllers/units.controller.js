import * as unitsService from '../services/units.service.js';

export const createUnits = async (request, reply) => {
  try {
    const result = await unitsService.createUnits(request.body);
    return reply.code(201).send(result);
  } catch (error) {
    if (error.name === 'ZodError') {
      return reply.code(400).send({ error: 'Validation Failed', details: error.errors });
    }
    request.log.error(error);
    return reply.code(500).send({ error: 'Internal Server Error' });
  }
};

export const getUnits = async (request, reply) => {
  try {
    // We prioritize the path param (:id), then the query (?ids=)
    const rawInput = request.params.id || request.query.ids;
    
    if (!rawInput) {
      return reply.code(400).send({ error: "Missing 'id' or 'ids' parameter" });
    }

    const units = await unitsService.getUnitsByIds(rawInput);
    return reply.send(units);
  } catch (error) {
    if (error.name === 'ZodError') {
      return reply.code(400).send({ 
        error: 'Validation Failed', 
        details: error.errors.map(e => ({ path: e.path, message: e.message })) 
      });
    }
    request.log.error(error);
    return reply.code(500).send({ error: 'Internal Server Error' });
  }
};


export const updateUnits = async (request, reply) => {
  try {
    const result = await unitsService.updateUnits(request.body);
    return reply.code(200).send(result);
  } catch (error) {
    if (error.name === 'ZodError') {
      return reply.code(400).send({ error: 'Validation Failed', details: error.errors });
    }
    request.log.error(error);
    return reply.code(500).send({ error: 'Internal Server Error' });
  }
};


export const updatePayloads = async (request, reply) => {
  try {
    const result = await unitsService.updatePayloads(request.body);
    return reply.send(result);
  } catch (error) {
    if (error.name === 'ZodError') {
      return reply.code(400).send({ error: 'Validation Failed', details: error.errors });
    }
    request.log.error(error);
    return reply.code(500).send({ error: 'Internal Server Error' });
  }
};


export const deleteUnits = async (request, reply) => {
  try {
    const result = await unitsService.deleteUnits(request.body);
    return reply.send(result);
  } catch (error) {
    if (error.name === 'ZodError') {
      return reply.code(400).send({ error: 'Validation Failed', details: error.errors });
    }
    request.log.error(error);
    return reply.code(500).send({ error: 'Internal Server Error' });
  }
};

