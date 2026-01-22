import { describe, it, expect, vi, beforeEach } from 'vitest';
import unitRoutes from '../../../src/routes/units.routes.js'; 
import * as unitsController from '../../../src/controllers/units.controller.js';

describe('Unit Routes', () => {
  let fastify;

  beforeEach(() => {
    // Create a mock Fastify instance
    fastify = {
      post: vi.fn(),
      get: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    };
  });

  it('should register all expected unit endpoints', async () => {
    await unitRoutes(fastify);

    // Verify POST /units
    expect(fastify.post).toHaveBeenCalledWith('/units', unitsController.createUnits);

    // Verify GET /units
    expect(fastify.get).toHaveBeenCalledWith('/units', unitsController.getUnits);

    // Verify PATCH /units (Labels)
    expect(fastify.patch).toHaveBeenCalledWith('/units', unitsController.updateUnits);

    // Verify PATCH /units/payload (Deep Merge)
    expect(fastify.patch).toHaveBeenCalledWith('/units/payload', unitsController.updatePayloads);

    // Verify DELETE /units
    expect(fastify.delete).toHaveBeenCalledWith('/units', unitsController.deleteUnits);
  });
});