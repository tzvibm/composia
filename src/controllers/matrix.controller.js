import * as matrixService from '../services/matrix.service.js';

export const linkUnits = async (request, reply) => {
  try {
    const result = matrixService.linkUnits(request.body);
    return reply.code(201).send(result);
  } catch (error) {
    if (error.name === 'ZodError') {
      return reply.code(400).send({ error: 'Validation Failed', details: error.errors });
    }
    if (error.message?.includes('not registered')) {
      return reply.code(404).send({ error: error.message });
    }
    request.log.error(error);
    return reply.code(500).send({ error: 'Internal Server Error' });
  }
};

export const unlinkUnits = async (request, reply) => {
  try {
    const deleted = matrixService.unlinkUnits(request.body);
    if (!deleted) {
      return reply.code(404).send({ error: 'Matrix entry not found' });
    }
    return reply.code(204).send();
  } catch (error) {
    if (error.name === 'ZodError') {
      return reply.code(400).send({ error: 'Validation Failed', details: error.errors });
    }
    request.log.error(error);
    return reply.code(500).send({ error: 'Internal Server Error' });
  }
};

export const getTargets = async (request, reply) => {
  try {
    const { namespace, source, verb } = request.query;
    if (!namespace || !source || !verb) {
      return reply.code(400).send({
        error: 'Missing required query parameters: namespace, source, verb'
      });
    }
    const result = matrixService.getTargets(namespace, source, verb);
    return reply.send(result);
  } catch (error) {
    request.log.error(error);
    return reply.code(500).send({ error: 'Internal Server Error' });
  }
};

export const getMatrixEntry = async (request, reply) => {
  try {
    const { namespace, source, verb, target } = request.query;
    if (!namespace || !source || !verb || !target) {
      return reply.code(400).send({
        error: 'Missing required query parameters: namespace, source, verb, target'
      });
    }
    const result = matrixService.getMatrixEntry(namespace, source, verb, target);
    if (!result) {
      return reply.code(404).send({ error: 'Matrix entry not found' });
    }
    return reply.send(result);
  } catch (error) {
    request.log.error(error);
    return reply.code(500).send({ error: 'Internal Server Error' });
  }
};

export const hasMatrixEntry = async (request, reply) => {
  try {
    const { namespace, source, verb, target } = request.query;
    if (!namespace || !source || !verb || !target) {
      return reply.code(400).send({
        error: 'Missing required query parameters: namespace, source, verb, target'
      });
    }
    const exists = matrixService.hasMatrixEntry(namespace, source, verb, target);
    return reply.send({ exists });
  } catch (error) {
    request.log.error(error);
    return reply.code(500).send({ error: 'Internal Server Error' });
  }
};

export const getMatrixSegment = async (request, reply) => {
  try {
    const { prefix } = request.query;
    if (!prefix) {
      return reply.code(400).send({ error: 'Missing required query parameter: prefix' });
    }
    const result = matrixService.getMatrixSegment(prefix);
    return reply.send(result);
  } catch (error) {
    request.log.error(error);
    return reply.code(500).send({ error: 'Internal Server Error' });
  }
};
