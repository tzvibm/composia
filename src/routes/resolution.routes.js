import * as resolutionController from '../controllers/resolution.controller.js';

export default async function resolutionRoutes(fastify, options) {
  // Resolve a unit hierarchy
  fastify.post('/resolve', resolutionController.resolveHierarchy);
}
