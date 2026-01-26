import Fastify from 'fastify';
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

// Register all routes
fastify.register(unitRoutes);
fastify.register(namespaceRoutes);
fastify.register(matrixRoutes);
fastify.register(resolutionRoutes);

export const start = async () => {
  try {
    const port = process.env.PORT || 3000;
    await fastify.listen({ port: Number(port), host: '0.0.0.0' });
    console.log(`🚀 Composia Engine running on port ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

// Start if executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  start();
}