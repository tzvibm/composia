import * as matrixController from '../controllers/matrix.controller.js';

const ErrorSchema = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    details: { type: 'array', items: { type: 'object' } }
  }
};

const MatrixEntrySchema = {
  type: 'object',
  properties: {
    namespace: { type: 'string' },
    source: { type: 'string' },
    verb: { type: 'string', enum: ['UNIT', 'HIDE', 'REPLACE', 'OVERLAY', 'MOUNT'] },
    target: { type: 'string' },
    order: { type: 'number' },
    verb_value: { type: 'string', nullable: true }
  }
};

const TargetSchema = {
  type: 'object',
  properties: {
    target: { type: 'string' },
    order: { type: 'number' },
    verb_value: { type: 'string', nullable: true }
  }
};

export default async function matrixRoutes(fastify, options) {
  // Create a matrix instruction (link units)
  fastify.post('/matrix/link', {
    schema: {
      tags: ['matrix'],
      summary: 'Create a matrix instruction (link units)',
      description: 'Links a source unit to a target unit with a verb. REPLACE, OVERLAY, and MOUNT verbs require verb_value.',
      body: MatrixEntrySchema,
      response: {
        201: MatrixEntrySchema,
        400: ErrorSchema,
        404: ErrorSchema
      }
    }
  }, matrixController.linkUnits);

  // Remove a matrix instruction (unlink units)
  fastify.delete('/matrix/link', {
    schema: {
      tags: ['matrix'],
      summary: 'Remove a matrix instruction',
      body: {
        type: 'object',
        required: ['namespace', 'source', 'verb', 'target'],
        properties: {
          namespace: { type: 'string' },
          source: { type: 'string' },
          verb: { type: 'string', enum: ['UNIT', 'HIDE', 'REPLACE', 'OVERLAY', 'MOUNT'] },
          target: { type: 'string' }
        }
      },
      response: {
        204: { type: 'null' },
        400: ErrorSchema,
        404: ErrorSchema
      }
    }
  }, matrixController.unlinkUnits);

  // Get all targets for a namespace:source:verb
  fastify.get('/matrix/targets', {
    schema: {
      tags: ['matrix'],
      summary: 'Get all targets for a source/verb combination',
      querystring: {
        type: 'object',
        required: ['namespace', 'source', 'verb'],
        properties: {
          namespace: { type: 'string' },
          source: { type: 'string' },
          verb: { type: 'string', enum: ['UNIT', 'HIDE', 'REPLACE', 'OVERLAY', 'MOUNT'] }
        }
      },
      response: {
        200: { type: 'array', items: TargetSchema },
        400: ErrorSchema
      }
    }
  }, matrixController.getTargets);

  // Get a specific matrix entry
  fastify.get('/matrix/entry', {
    schema: {
      tags: ['matrix'],
      summary: 'Get a specific matrix entry',
      querystring: {
        type: 'object',
        required: ['namespace', 'source', 'verb', 'target'],
        properties: {
          namespace: { type: 'string' },
          source: { type: 'string' },
          verb: { type: 'string' },
          target: { type: 'string' }
        }
      },
      response: {
        200: {
          type: 'object',
          properties: {
            order: { type: 'number' },
            verb_value: { type: 'string', nullable: true }
          }
        },
        400: ErrorSchema,
        404: ErrorSchema
      }
    }
  }, matrixController.getMatrixEntry);

  // Check if a matrix entry exists
  fastify.get('/matrix/exists', {
    schema: {
      tags: ['matrix'],
      summary: 'Check if a matrix entry exists',
      querystring: {
        type: 'object',
        required: ['namespace', 'source', 'verb', 'target'],
        properties: {
          namespace: { type: 'string' },
          source: { type: 'string' },
          verb: { type: 'string' },
          target: { type: 'string' }
        }
      },
      response: {
        200: {
          type: 'object',
          properties: {
            exists: { type: 'boolean' }
          }
        },
        400: ErrorSchema
      }
    }
  }, matrixController.hasMatrixEntry);

  // Get matrix entries by prefix (admin/debug)
  fastify.get('/matrix/segment', {
    schema: {
      tags: ['matrix'],
      summary: 'Get matrix entries by prefix (debug)',
      querystring: {
        type: 'object',
        required: ['prefix'],
        properties: {
          prefix: { type: 'string' }
        }
      },
      response: {
        200: { type: 'array', items: MatrixEntrySchema },
        400: ErrorSchema
      }
    }
  }, matrixController.getMatrixSegment);
}
