const unitsController = require('../controllers/units.controller');

async function unitRoutes(fastify, options) {
  fastify.post('/units', unitsController.createUnits);
}

module.exports = unitRoutes;