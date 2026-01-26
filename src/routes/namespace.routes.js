import * as namespaceController from '../controllers/namespace.controller.js';

export default async function namespaceRoutes(fastify, options) {
  // Register a new namespace
  fastify.post('/namespaces', namespaceController.registerNamespace);

  // List all namespaces
  fastify.get('/namespaces', namespaceController.listNamespaces);

  // Get a specific namespace
  fastify.get('/namespaces/:id', namespaceController.getNamespace);

  // Delete a namespace
  fastify.delete('/namespaces/:id', namespaceController.deleteNamespace);
}
