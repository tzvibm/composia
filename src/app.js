const fastify = require('fastify')({ logger: true });

// 1. Register Plugins
fastify.register(require('@fastify/cors'), { 
  origin: true 
});

// 2. Register Feature Routes
// This hooks up the /units endpoint we just built
fastify.register(require('./routes/units.routes'));

// 3. Health Check
fastify.get('/health', async () => ({ status: 'ok' }));

/**
 * Server Start Logic
 */
const start = async () => {
  try {
    const port = process.env.PORT || 3000;
    await fastify.listen({ port, host: '0.0.0.0' });
    console.log(`🚀 Kernel running on http://localhost:${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

module.exports = { start };