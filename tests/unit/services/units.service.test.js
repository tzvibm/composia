import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as unitsService from '../../../src/services/units.service.js';
import * as unitsRepo from '../../../src/dal/units.repository.js';

// Mock the repository
vi.mock('../../../src/dal/units.repository.js');

describe('Units Service Unit Tests', () => {
  const validId = '9b8133e287b0712ed310acf7d3aee0b9';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createUnits', () => {
    it('should generate IDs and call the repository with validated data', async () => {
      const input = [{ label: 'Service Test', payload: { key: 'val' } }];
      unitsRepo.createUnits.mockResolvedValue([{ 
        id: validId, 
        label: 'Service Test', 
        payload: { key: 'val' },
        created_at: new Date()
      }]);

      const result = await unitsService.createUnits(input);
      expect(unitsRepo.createUnits).toHaveBeenCalledTimes(1);
      expect(result[0].label).toBe('Service Test');
    });

    it('should throw if input validation fails', async () => {
      const badInput = [{ payload: {} }]; 
      await expect(unitsService.createUnits(badInput)).rejects.toThrow();
    });
  });

  describe('updateUnits', () => {
    it('should call repo with validated labels', async () => {
      const input = [{ id: validId, label: 'New Label' }];
      unitsRepo.updateUnits.mockResolvedValue([{ id: validId, label: 'New Label', payload: {}, created_at: new Date() }]);

      const result = await unitsService.updateUnits(input);
      expect(unitsRepo.updateUnits).toHaveBeenCalledWith(input);
      expect(result[0].label).toBe('New Label');
    });
  });

  describe('updatePayloads', () => {
    it('should call repo with validated payload merges', async () => {
      const input = [{ id: validId, payload: { status: 'active' } }];
      unitsRepo.updatePayloads.mockResolvedValue([{ id: validId, label: 'Test', payload: { status: 'active' }, created_at: new Date() }]);

      const result = await unitsService.updatePayloads(input);
      expect(unitsRepo.updatePayloads).toHaveBeenCalledWith(input);
      expect(result[0].payload.status).toBe('active');
    });
  });

  describe('getUnitsByIds', () => {
    it('should handle comma-separated strings', async () => {
      unitsRepo.readUnits.mockResolvedValue([]);
      await unitsService.getUnitsByIds(`${validId},${validId}`);
      expect(unitsRepo.readUnits).toHaveBeenCalledWith([validId, validId]);
    });
  });

  describe('deleteUnits', () => {
    it('should return the correct count', async () => {
      const mockResult = { deleted: [validId], count: 1 };
      unitsRepo.deleteBatch.mockResolvedValue(mockResult);
      const result = await unitsService.deleteUnits({ ids: [validId] });
      expect(result).toEqual(mockResult);
    });
  });
});