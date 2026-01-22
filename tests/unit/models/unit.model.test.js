import { describe, it, expect } from 'vitest';
import { 
  UnitSchema, 
  CreateRequestSchema, 
  ReadRequestSchema, 
  DeleteUnitsRequestSchema 
} from '../../../src/models/unit.model.js';

describe('Unit Models (Zod Schemas)', () => {
  const validId = '9b8133e287b0712ed310acf7d3aee0b9';
  const invalidId = 'not-a-hex-id';

  describe('UnitId Validation', () => {
    it('should accept a valid 32-char hex string', () => {
      const result = UnitSchema.pick({ id: true }).safeParse({ id: validId });
      expect(result.success).toBe(true);
    });

    it('should reject IDs that are not 32 characters', () => {
      const result = UnitSchema.pick({ id: true }).safeParse({ id: 'abc123' });
      expect(result.success).toBe(false);
    });

    it('should reject IDs with non-hex characters', () => {
      const result = UnitSchema.pick({ id: true }).safeParse({ id: 'z'.repeat(32) });
      expect(result.success).toBe(false);
    });
  });

  describe('CreateRequestSchema', () => {
    it('should accept valid array of objects', () => {
      const payload = [{ label: 'Test Unit', payload: { foo: 'bar' } }];
      const result = CreateRequestSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });

    it('should provide default empty object for missing payload', () => {
      const payload = [{ label: 'Test Unit' }];
      const result = CreateRequestSchema.safeParse(payload);
      expect(result.data[0].payload).toEqual({});
    });

    it('should reject empty arrays', () => {
      const result = CreateRequestSchema.safeParse([]);
      expect(result.success).toBe(false);
    });
  });

  describe('ReadRequestSchema (Pre-processing)', () => {
    it('should transform a comma-separated string into an array', () => {
      const input = `${validId},${validId}`;
      const result = ReadRequestSchema.safeParse(input);
      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(2);
      expect(result.data[0]).toBe(validId);
    });

    it('should accept a standard array of IDs', () => {
      const input = [validId];
      const result = ReadRequestSchema.safeParse(input);
      expect(result.success).toBe(true);
    });
  });

  describe('DeleteUnitsRequestSchema', () => {
    it('should reject if "ids" key is missing', () => {
      const result = DeleteUnitsRequestSchema.safeParse({ wrongKey: [validId] });
      expect(result.success).toBe(false);
    });

    it('should accept a valid list of IDs', () => {
      const result = DeleteUnitsRequestSchema.safeParse({ ids: [validId] });
      expect(result.success).toBe(true);
    });
  });
});