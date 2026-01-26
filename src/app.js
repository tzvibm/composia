import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import unitRoutes from './routes/units.routes.js';
import namespaceRoutes from './routes/namespace.routes.js';
import matrixRoutes from './routes/matrix.routes.js';
import resolutionRoutes from './routes/resolution.routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envFile = process.env.NODE_ENV === 'test' ? '.env.test' : '.env';

// Load env from root directory
dotenv.config({ path: path.resolve(__dirname, '..', envFile) });

export const fastify = Fastify({
  logger: process.env.NODE_ENV !== 'test'
});

// Global error handler
fastify.setErrorHandler((error, request, reply) => {
  // Zod validation errors
  if (error.name === 'ZodError') {
    return reply.code(400).send({
      error: 'Validation Failed',
      details: error.errors.map(e => ({
        path: e.path.join('.'),
        message: e.message
      }))
    });
  }

  // Known application errors
  if (error.message?.includes('not found') || error.message?.includes('not registered')) {
    return reply.code(404).send({ error: error.message });
  }

  if (error.message?.includes('already exists')) {
    return reply.code(409).send({ error: error.message });
  }

  // Log unexpected errors
  request.log.error(error);
  return reply.code(500).send({ error: 'Internal Server Error' });
});

// Register Swagger (skip in test environment)
if (process.env.NODE_ENV !== 'test') {
  await fastify.register(swagger, {
    openapi: {
      info: {
        title: 'Composia API',
        description: 'Backend orchestration engine for assembling hierarchical data structures',
        version: '2.0.0'
      },
      servers: [
        { url: 'http://localhost:3000', description: 'Development server' }
      ],
      tags: [
        { name: 'units', description: 'Unit CRUD operations' },
        { name: 'namespaces', description: 'Namespace management' },
        { name: 'matrix', description: 'Instruction matrix operations' },
        { name: 'resolution', description: 'Hierarchy resolution' }
      ],
      components: {
        schemas: {
          Unit: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '32-char hex ID', example: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4' },
              label: { type: 'string', example: 'My Unit' },
              payload: { type: 'object', additionalProperties: true }
            }
          },
          Namespace: {
            type: 'object',
            properties: {
              id: { type: 'string', example: 'admin_view' },
              metadata: { type: 'object', additionalProperties: true }
            }
          },
          MatrixEntry: {
            type: 'object',
            properties: {
              namespace: { type: 'string' },
              source: { type: 'string', description: '32-char hex ID' },
              verb: { type: 'string', enum: ['UNIT', 'HIDE', 'REPLACE', 'OVERLAY', 'MOUNT'] },
              target: { type: 'string', description: '32-char hex ID' },
              order: { type: 'number', default: 0 },
              verb_value: { type: 'string', nullable: true, description: 'Required for REPLACE, OVERLAY, MOUNT' }
            }
          },
          ResolveRequest: {
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
          },
          ResolvedHierarchy: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              original_id: { type: 'string', description: 'Present if unit was replaced' },
              label: { type: 'string' },
              payload: { type: 'object' },
              children: { type: 'array', items: { $ref: '#/components/schemas/ResolvedHierarchy' } }
            }
          },
          Error: {
            type: 'object',
            properties: {
              error: { type: 'string' },
              details: { type: 'array', items: { type: 'object' } }
            }
          }
        }
      }
    }
  });

  await fastify.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true
    }
  });
}

// Register all routes
fastify.register(unitRoutes);
fastify.register(namespaceRoutes);
fastify.register(matrixRoutes);
fastify.register(resolutionRoutes);

// Health check endpoint
fastify.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

export const start = async () => {
  try {
    const port = process.env.PORT || 3000;
    await fastify.listen({ port: Number(port), host: '0.0.0.0' });
    console.log(`🚀 Composia Engine running on port ${port}`);
    if (process.env.NODE_ENV !== 'test') {
      console.log(`📚 API docs available at http://localhost:${port}/docs`);
    }
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

// Start if executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  start();
}
