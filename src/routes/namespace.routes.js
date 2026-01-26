import * as namespaceController from '../controllers/namespace.controller.js';

const NamespaceSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    metadata: { type: 'object', additionalProperties: true }
  }
};

const ErrorSchema = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    details: { type: 'array', items: { type: 'object' } }
  }
};

export default async function namespaceRoutes(fastify, options) {
  // Register a new namespace
  fastify.post('/namespaces', {
    schema: {
      tags: ['namespaces'],
      summary: 'Register a new namespace',
      body: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 64 },
          metadata: { type: 'object', additionalProperties: true, default: {} }
        }
      },
      response: {
        201: NamespaceSchema,
        400: ErrorSchema,
        409: ErrorSchema
      }
    }
  }, namespaceController.registerNamespace);

  // List all namespaces
  fastify.get('/namespaces', {
    schema: {
      tags: ['namespaces'],
      summary: 'List all namespaces',
      response: {
        200: {
          type: 'array',
          items: NamespaceSchema
        }
      }
    }
  }, namespaceController.listNamespaces);

  // Get a specific namespace
  fastify.get('/namespaces/:id', {
    schema: {
      tags: ['namespaces'],
      summary: 'Get a namespace by ID',
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' }
        }
      },
      response: {
        200: NamespaceSchema,
        404: ErrorSchema
      }
    }
  }, namespaceController.getNamespace);

  // Delete a namespace
  fastify.delete('/namespaces/:id', {
    schema: {
      tags: ['namespaces'],
      summary: 'Delete a namespace',
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' }
        }
      },
      response: {
        204: { type: 'null' },
        404: ErrorSchema
      }
    }
  }, namespaceController.deleteNamespace);
}
