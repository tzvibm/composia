import Fastify from 'fastify';
import cors from '@fastify/cors';
import unitRoutes from './routes/units.routes.js';

const fastify = Fastify({ logger: true });

fastify.register(cors, { origin: true });
fastify.register(unitRoutes);

export const start = async () => {
  try {
    await fastify.listen({ port: process.env.PORT || 3000, host: '0.0.0.0' });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};