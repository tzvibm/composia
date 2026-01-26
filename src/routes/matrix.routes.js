import * as matrixController from '../controllers/matrix.controller.js';

export default async function matrixRoutes(fastify, options) {
  // Create a matrix instruction (link units)
  fastify.post('/matrix/link', matrixController.linkUnits);

  // Remove a matrix instruction (unlink units)
  fastify.delete('/matrix/link', matrixController.unlinkUnits);

  // Get all targets for a namespace:source:verb
  fastify.get('/matrix/targets', matrixController.getTargets);

  // Get a specific matrix entry
  fastify.get('/matrix/entry', matrixController.getMatrixEntry);

  // Check if a matrix entry exists
  fastify.get('/matrix/exists', matrixController.hasMatrixEntry);

  // Get matrix entries by prefix (admin/debug)
  fastify.get('/matrix/segment', matrixController.getMatrixSegment);
}
