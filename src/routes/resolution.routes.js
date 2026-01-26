import * as resolutionController from '../controllers/resolution.controller.js';

const ErrorSchema = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    details: { type: 'array', items: { type: 'object' } }
  }
};

const ResolveRequestSchema = {
  type: 'object',
  required: ['namespace', 'unit_id'],
  properties: {
    namespace: { type: 'string', description: 'Namespace to resolve within' },
    unit_id: { type: 'string', description: 'Root unit ID (32-char hex)' },
    depth: { type: 'integer', default: 2, minimum: 0, maximum: 10 },
    width: { type: 'integer', default: 10, minimum: 1, maximum: 100 },
    offset: { type: 'integer', default: 0, minimum: 0 },
    include_ops: { type: 'boolean', default: false, description: 'Include operation log' }
  }
};

export default async function resolutionRoutes(fastify, options) {
  // Resolve a unit hierarchy
  fastify.post('/resolve', {
    schema: {
      tags: ['resolution'],
      summary: 'Resolve a unit hierarchy',
      description: `Resolves a unit tree starting from the given root unit ID, applying the 8-step resolution cycle:
1. Mount Check - Check for MOUNT verb (carries its own namespace)
2. Hide Check - Check both namespaces for HIDE instruction
3. Replacement Logic - Apply REPLACE verb from mount then namespace
4. Overlay Retrieval - Get overlays from both namespaces
5. Merge Priority - Merge overlays (mount first, namespace overrides)
6. Structure Update - Build the resolved unit object
7. Width Limitation - Get children with pagination
8. Recurse - Process children recursively`,
      body: ResolveRequestSchema,
      response: {
        200: {
          type: 'object',
          properties: {
            hierarchy: {
              type: 'object',
              nullable: true,
              properties: {
                id: { type: 'string' },
                original_id: { type: 'string' },
                label: { type: 'string' },
                payload: { type: 'object' },
                children: { type: 'array' }
              }
            },
            operations: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  step: { type: 'integer' },
                  action: { type: 'string' },
                  details: { type: 'object' }
                }
              }
            }
          }
        },
        400: ErrorSchema,
        404: ErrorSchema
      }
    }
  }, resolutionController.resolveHierarchy);
}
