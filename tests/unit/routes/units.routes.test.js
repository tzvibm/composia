import { describe, it, expect, vi, beforeEach } from 'vitest';
// Import the default export and name it unitRoutes
import unitRoutes from '../../../src/routes/units.routes.js';
import * as unitsController from '../../../src/controllers/units.controller.js';

describe('Unit Routes', () => {
  let fastify;

  beforeEach(() => {
    // Mock the Fastify instance
    fastify = {
      post: vi.fn(),
      get: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    };
  });

  it('should register all expected unit endpoints', async () => {
    await unitRoutes(fastify);

    // Verify all routes are registered with the correct controller methods
    expect(fastify.post).toHaveBeenCalledWith('/units', unitsController.createUnits);
    expect(fastify.get).toHaveBeenCalledWith('/units', unitsController.getUnits);
    expect(fastify.patch).toHaveBeenCalledWith('/units', unitsController.updateUnits);
    expect(fastify.patch).toHaveBeenCalledWith('/units/payload', unitsController.updatePayloads);
    expect(fastify.delete).toHaveBeenCalledWith('/units', unitsController.deleteUnits);
  });
});