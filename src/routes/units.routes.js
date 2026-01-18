import * as unitsController from '../controllers/units.controller.js';

export default async function unitRoutes(fastify, options) {
    fastify.post('/units', unitsController.createUnits);
    fastify.get('/units', unitsController.getUnits);
    fastify.get('/units/:id', unitsController.getUnits);
    fastify.patch('/units', unitsController.updateUnits);
}