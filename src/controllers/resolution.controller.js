import * as resolutionService from '../services/resolution.service.js';

export const resolveHierarchy = async (request, reply) => {
  try {
    const result = resolutionService.resolveHierarchy(request.body);
    return reply.send(result);
  } catch (error) {
    if (error.name === 'ZodError') {
      return reply.code(400).send({ error: 'Validation Failed', details: error.errors });
    }
    if (error.message?.includes('not found')) {
      return reply.code(404).send({ error: error.message });
    }
    request.log.error(error);
    return reply.code(500).send({ error: 'Internal Server Error' });
  }
};
