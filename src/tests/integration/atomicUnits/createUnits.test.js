import { test, expect, describe, beforeEach, afterAll } from 'vitest';

import { fastify } from '../../../app.js'; 
import { db, cleanDb, closeDb } from '../../../dal/db.js';

describe('Workflow: Create Units', () => {
  
  // Clean the slate before every test using our new helper
  beforeEach(async () => {
    await cleanDb();
  });

  // Critical for Vitest: Close the pool so the test process finishes
  afterAll(async () => {
    await closeDb();
  });

  describe('Success Scenarios', () => {
    
    test('should create a single unit with a 32-char ID and default payload', async () => {
      const payload = [{ label: 'Master Controller' }];

      const response = await fastify.inject({
        method: 'POST',
        url: '/units',
        payload
      });

      const body = JSON.parse(response.payload);

      expect(response.statusCode).toBe(201);
      expect(body).toHaveLength(1);
      // Verify ID is 32 chars as per your schema
      expect(body[0].id).toHaveLength(32);
      expect(body[0].label).toBe('Master Controller');
      expect(body[0].payload).toEqual({}); 
    });

    test('should create bulk units and verify all IDs are unique', async () => {
      const payload = [
        { label: 'Sensor 01' },
        { label: 'Sensor 02' },
        { label: 'Sensor 03' },
        { label: 'Sensor 04' },
        { label: 'Sensor 05' }
      ];

      const response = await fastify.inject({
        method: 'POST',
        url: '/units',
        payload
      });

      const units = JSON.parse(response.payload);

      expect(response.statusCode).toBe(201);
      expect(units).toHaveLength(5);

      const idSet = new Set(units.map(u => u.id));
      expect(idSet.size).toBe(5);
    });

    test('should persist complex nested JSON payloads correctly', async () => {
      const complexPayload = {
        config: { thresholds: [10, 20, 30], active: true },
        metadata: { vendor: 'Composia', version: 1.2 }
      };
      
      const payload = [{ label: 'Complex Unit', payload: complexPayload }];

      const response = await fastify.inject({
        method: 'POST',
        url: '/units',
        payload
      });

      const body = JSON.parse(response.payload);
      expect(response.statusCode).toBe(201);
      expect(body[0].payload).toEqual(complexPayload);
    });
  });

  describe('Failure & Validation Scenarios', () => {

    test('should return 400 if the array is empty (Zod min 1)', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/units',
        payload: []
      });

      expect(response.statusCode).toBe(400);
    });

    test('should return 400 if label is missing or empty string', async () => {
      const payload = [{ label: '', payload: {} }];

      const response = await fastify.inject({
        method: 'POST',
        url: '/units',
        payload
      });

      expect(response.statusCode).toBe(400);
    });

    test('should return 400 if payload is not an object', async () => {
      const payload = [{ label: 'Broken Unit', payload: "not-an-object" }];

      const response = await fastify.inject({
        method: 'POST',
        url: '/units',
        payload
      });

      expect(response.statusCode).toBe(400);
    });

    test('should return 400 if input is a single object instead of an array', async () => {
      const payload = { label: 'I should be in an array' };

      const response = await fastify.inject({
        method: 'POST',
        url: '/units',
        payload
      });

      expect(response.statusCode).toBe(400);
    });
  });
});