import Fastify from 'fastify';
import dotenv from 'dotenv';
import path from 'path';
import unitRoutes from './routes/units.routes.js'; 

const envFile = process.env.NODE_ENV === 'test' ? '.env.test' : '.env';
dotenv.config({ path: path.resolve(process.cwd(), envFile) });

// TIP: Turn off logger in test mode so your terminal isn't flooded with logs
export const fastify = Fastify({ 
  logger: process.env.NODE_ENV !== 'test' 
});

fastify.register(unitRoutes);

export const start = async () => {
  try {
    // This now correctly pulls from whichever file was loaded above
    await fastify.listen({ 
        port: process.env.PORT || 3000, 
        host: '0.0.0.0' 
    });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};