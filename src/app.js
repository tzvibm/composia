const fastify = require('fastify')({ logger: true });

// 1. Register Plugins
fastify.register(require('@fastify/cors'), { 
  origin: true // Adjust for production later
});

// 2. Placeholder for Routes (to be connected in #36)
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