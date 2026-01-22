import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as unitsRepo from '../../../src/dal/units.repository.js';
import { cleanDb, closeDb } from '../../../src/dal/db.js';

describe('Units Repository Integration Tests', () => {
  
  beforeAll(async () => {
    await cleanDb();
  });

  beforeEach(async () => {
    await cleanDb();
  });

  afterAll(async () => {
    await closeDb();
  });

  const testUnit1 = {
    id: 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6',
    label: 'Unit One',
    payload: { color: 'blue' }
  };

  const testUnit2 = {
    id: 'z9y8x7w6v5u4t3s2r1q0p9o8n7m6l5k4',
    label: 'Unit Two',
    payload: { color: 'red' }
  };

  it('should insert multiple units in a single batch using UNNEST', async () => {
    const created = await unitsRepo.createUnits([testUnit1, testUnit2]);
    
    expect(created).toHaveLength(2);
    expect(created.map(u => u.id)).toContain(testUnit1.id);
    expect(created.map(u => u.id)).toContain(testUnit2.id);
  });

  it('should read multiple units by an array of IDs', async () => {
    await unitsRepo.createUnits([testUnit1, testUnit2]);

    const rows = await unitsRepo.readUnits([testUnit1.id, testUnit2.id]);
    expect(rows).toHaveLength(2);
  });

  it('should deep merge payloads for a batch of units', async () => {
    await unitsRepo.createUnits([testUnit1, testUnit2]);

    const updates = [
      { id: testUnit1.id, payload: { version: 2 } },
      { id: testUnit2.id, payload: { status: 'active' } }
    ];

    const updated = await unitsRepo.updatePayloads(updates);
    
    const u1 = updated.find(u => u.id === testUnit1.id);
    const u2 = updated.find(u => u.id === testUnit2.id);

    expect(u1.payload).toEqual({ color: 'blue', version: 2 });
    expect(u2.payload).toEqual({ color: 'red', status: 'active' });
  });

  it('should update labels for a batch of units', async () => {
    await unitsRepo.createUnits([testUnit1, testUnit2]);

    const updates = [
      { id: testUnit1.id, label: 'New One' },
      { id: testUnit2.id, label: 'New Two' }
    ];

    const updated = await unitsRepo.updateUnits(updates);
    expect(updated.find(u => u.id === testUnit1.id).label).toBe('New One');
    expect(updated.find(u => u.id === testUnit2.id).label).toBe('New Two');
  });

  it('should delete a batch of units and return the count and IDs', async () => {
    await unitsRepo.createUnits([testUnit1, testUnit2]);

    const result = await unitsRepo.deleteBatch([testUnit1.id, testUnit2.id]);
    
    expect(result.count).toBe(2);
    expect(result.deleted).toContain(testUnit1.id);
    expect(result.deleted).toContain(testUnit2.id);

    const check = await unitsRepo.readUnits([testUnit1.id, testUnit2.id]);
    expect(check).toHaveLength(0);
  });
});