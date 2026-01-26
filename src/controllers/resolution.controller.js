import * as resolutionService from '../services/resolution.service.js';

export const resolveHierarchy = async (request, reply) => {
  const result = resolutionService.resolveHierarchy(request.body);
  return reply.send(result);
};
