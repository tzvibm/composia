import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as unitsController from '../../../src/controllers/units.controller.js';
import * as unitsService from '../../../src/services/units.service.js';

vi.mock('../../../src/services/units.service.js');

describe('Units Controller Unit Tests', () => {
  let mockRequest;
  let mockReply;
  const mockUnit = { id: '9b8133e287b0712ed310acf7d3aee0b9', label: 'Test' };

  beforeEach(() => {
    vi.clearAllMocks();
    mockRequest = {
      body: {}, query: {}, params: {},
      log: { error: vi.fn() }
    };
    mockReply = {
      code: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis()
    };
  });

  describe('Happy Paths', () => {
    it('createUnits should return 201', async () => {
      unitsService.createUnits.mockResolvedValue([mockUnit]);
      mockRequest.body = [{ label: 'Test' }];
      await unitsController.createUnits(mockRequest, mockReply);
      expect(mockReply.code).toHaveBeenCalledWith(201);
      expect(mockReply.send).toHaveBeenCalledWith([mockUnit]);
    });

    it('getUnits should return 200 with path param', async () => {
      mockRequest.params.id = mockUnit.id;
      unitsService.getUnitsByIds.mockResolvedValue([mockUnit]);
      await unitsController.getUnits(mockRequest, mockReply);
      expect(mockReply.send).toHaveBeenCalledWith([mockUnit]);
    });

    it('getUnits should return 200 with query param', async () => {
      mockRequest.query.ids = mockUnit.id;
      unitsService.getUnitsByIds.mockResolvedValue([mockUnit]);
      await unitsController.getUnits(mockRequest, mockReply);
      expect(unitsService.getUnitsByIds).toHaveBeenCalledWith(mockUnit.id);
    });

    it('updateUnits should return 200', async () => {
      unitsService.updateUnits.mockResolvedValue([mockUnit]);
      mockRequest.body = [{ id: mockUnit.id, label: 'New' }];
      await unitsController.updateUnits(mockRequest, mockReply);
      expect(mockReply.code).toHaveBeenCalledWith(200);
    });

    it('updatePayloads should return 200', async () => {
      unitsService.updatePayloads.mockResolvedValue([mockUnit]);
      mockRequest.body = [{ id: mockUnit.id, payload: { a: 1 } }];
      await unitsController.updatePayloads(mockRequest, mockReply);
      expect(mockReply.send).toHaveBeenCalledWith([mockUnit]);
    });

    it('deleteUnits should return 200', async () => {
      const result = { deleted: [mockUnit.id], count: 1 };
      unitsService.deleteUnits.mockResolvedValue(result);
      mockRequest.body = { ids: [mockUnit.id] };
      await unitsController.deleteUnits(mockRequest, mockReply);
      expect(mockReply.send).toHaveBeenCalledWith(result);
    });
  });

  describe('Edge Cases', () => {
    it('getUnits should return 400 if no ID is provided', async () => {
      // Both are empty
      mockRequest.params.id = undefined;
      mockRequest.query.ids = undefined;

      await unitsController.getUnits(mockRequest, mockReply);
      expect(mockReply.code).toHaveBeenCalledWith(400);
      expect(mockReply.send).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.stringContaining("Missing 'id'")
      }));
    });
  });

  describe('Global Error Handling', () => {
    const endpoints = [
      { name: 'createUnits', serviceMethod: 'createUnits' },
      { name: 'updateUnits', serviceMethod: 'updateUnits' },
      { name: 'updatePayloads', serviceMethod: 'updatePayloads' },
      { name: 'deleteUnits', serviceMethod: 'deleteUnits' },
      { name: 'getUnits', serviceMethod: 'getUnitsByIds' }
    ];

    endpoints.forEach(({ name, serviceMethod }) => {
      it(`${name} should return 400 on ZodError`, async () => {
        const zodError = new Error();
        zodError.name = 'ZodError';
        zodError.errors = [{ path: ['test'], message: 'fail' }];
        
        unitsService[serviceMethod].mockRejectedValue(zodError);

        if (name === 'getUnits') mockRequest.params.id = mockUnit.id;

        await unitsController[name](mockRequest, mockReply);
        expect(mockReply.code).toHaveBeenCalledWith(400);
      });

      it(`${name} should return 500 on generic error`, async () => {
        const err = new Error('Internal Crash');
        unitsService[serviceMethod].mockRejectedValue(err);
        
        if (name === 'getUnits') mockRequest.params.id = mockUnit.id;

        await unitsController[name](mockRequest, mockReply);
        expect(mockRequest.log.error).toHaveBeenCalledWith(err);
        expect(mockReply.code).toHaveBeenCalledWith(500);
      });
    });
  });
});