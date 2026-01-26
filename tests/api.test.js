import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { fastify } from '../src/app.js';
import { cleanDb } from '../src/dal/db.js';

describe('API Integration Tests', () => {
  beforeAll(async () => {
    await fastify.ready();
  });

  afterAll(async () => {
    await fastify.close();
  });

  beforeEach(() => {
    cleanDb();
  });

  // Helper to create proper 32-char hex IDs (only hex chars: 0-9, a-f)
  const makeId = (name) => {
    // Create a simple hex hash from the name
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = ((hash << 5) - hash) + name.charCodeAt(i);
      hash = hash & hash;
    }
    const hex = Math.abs(hash).toString(16);
    return hex.padEnd(32, '0').slice(0, 32);
  };

  describe('Namespace Routes', () => {
    it('POST /namespaces - should register a new namespace', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/namespaces',
        payload: { id: 'test_ns', metadata: { owner: 'test' } }
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload);
      expect(body.id).toBe('test_ns');
      expect(body.metadata.owner).toBe('test');
    });

    it('POST /namespaces - should return 409 if namespace exists', async () => {
      await fastify.inject({
        method: 'POST',
        url: '/namespaces',
        payload: { id: 'dup_ns', metadata: {} }
      });

      const response = await fastify.inject({
        method: 'POST',
        url: '/namespaces',
        payload: { id: 'dup_ns', metadata: {} }
      });

      expect(response.statusCode).toBe(409);
    });

    it('GET /namespaces - should list all namespaces', async () => {
      await fastify.inject({
        method: 'POST',
        url: '/namespaces',
        payload: { id: 'ns1', metadata: {} }
      });
      await fastify.inject({
        method: 'POST',
        url: '/namespaces',
        payload: { id: 'ns2', metadata: {} }
      });

      const response = await fastify.inject({
        method: 'GET',
        url: '/namespaces'
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body).toHaveLength(2);
    });

    it('GET /namespaces/:id - should get a specific namespace', async () => {
      await fastify.inject({
        method: 'POST',
        url: '/namespaces',
        payload: { id: 'my_ns', metadata: { key: 'value' } }
      });

      const response = await fastify.inject({
        method: 'GET',
        url: '/namespaces/my_ns'
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.id).toBe('my_ns');
      expect(body.metadata.key).toBe('value');
    });

    it('GET /namespaces/:id - should return 404 for non-existent', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/namespaces/not_found'
      });

      expect(response.statusCode).toBe(404);
    });

    it('DELETE /namespaces/:id - should delete a namespace', async () => {
      await fastify.inject({
        method: 'POST',
        url: '/namespaces',
        payload: { id: 'to_delete', metadata: {} }
      });

      const response = await fastify.inject({
        method: 'DELETE',
        url: '/namespaces/to_delete'
      });

      expect(response.statusCode).toBe(204);

      // Verify it's gone
      const getResponse = await fastify.inject({
        method: 'GET',
        url: '/namespaces/to_delete'
      });
      expect(getResponse.statusCode).toBe(404);
    });
  });

  describe('Matrix Routes', () => {
    beforeEach(async () => {
      // Create a namespace for matrix tests
      await fastify.inject({
        method: 'POST',
        url: '/namespaces',
        payload: { id: 'matrix_ns', metadata: {} }
      });
    });

    it('POST /matrix/link - should create a matrix entry', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/matrix/link',
        payload: {
          namespace: 'matrix_ns',
          source: makeId('src'),
          verb: 'UNIT',
          target: makeId('tgt'),
          order: 1
        }
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload);
      expect(body.namespace).toBe('matrix_ns');
      expect(body.verb).toBe('UNIT');
    });

    it('POST /matrix/link - should return 404 for non-existent namespace', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/matrix/link',
        payload: {
          namespace: 'no_such_ns',
          source: makeId('src'),
          verb: 'UNIT',
          target: makeId('tgt'),
          order: 1
        }
      });

      expect(response.statusCode).toBe(404);
    });

    it('GET /matrix/targets - should get targets for source/verb', async () => {
      const srcId = makeId('src2');
      await fastify.inject({
        method: 'POST',
        url: '/matrix/link',
        payload: {
          namespace: 'matrix_ns',
          source: srcId,
          verb: 'UNIT',
          target: makeId('t1'),
          order: 1
        }
      });
      await fastify.inject({
        method: 'POST',
        url: '/matrix/link',
        payload: {
          namespace: 'matrix_ns',
          source: srcId,
          verb: 'UNIT',
          target: makeId('t2'),
          order: 2
        }
      });

      const response = await fastify.inject({
        method: 'GET',
        url: `/matrix/targets?namespace=matrix_ns&source=${srcId}&verb=UNIT`
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body).toHaveLength(2);
      expect(body[0].order).toBe(1);
      expect(body[1].order).toBe(2);
    });

    it('GET /matrix/exists - should check if entry exists', async () => {
      const srcId = makeId('src3');
      const tgtId = makeId('tgt3');

      await fastify.inject({
        method: 'POST',
        url: '/matrix/link',
        payload: {
          namespace: 'matrix_ns',
          source: srcId,
          verb: 'HIDE',
          target: tgtId,
          order: 0
        }
      });

      const response = await fastify.inject({
        method: 'GET',
        url: `/matrix/exists?namespace=matrix_ns&source=${srcId}&verb=HIDE&target=${tgtId}`
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.exists).toBe(true);
    });

    it('DELETE /matrix/link - should remove a matrix entry', async () => {
      const srcId = makeId('src4');
      const tgtId = makeId('tgt4');

      await fastify.inject({
        method: 'POST',
        url: '/matrix/link',
        payload: {
          namespace: 'matrix_ns',
          source: srcId,
          verb: 'UNIT',
          target: tgtId,
          order: 1
        }
      });

      const response = await fastify.inject({
        method: 'DELETE',
        url: '/matrix/link',
        payload: {
          namespace: 'matrix_ns',
          source: srcId,
          verb: 'UNIT',
          target: tgtId
        }
      });

      expect(response.statusCode).toBe(204);

      // Verify it's gone
      const existsResponse = await fastify.inject({
        method: 'GET',
        url: `/matrix/exists?namespace=matrix_ns&source=${srcId}&verb=UNIT&target=${tgtId}`
      });
      const body = JSON.parse(existsResponse.payload);
      expect(body.exists).toBe(false);
    });
  });

  describe('Resolution Routes', () => {
    const NS = 'resolve_ns';

    beforeEach(async () => {
      // Create namespace
      await fastify.inject({
        method: 'POST',
        url: '/namespaces',
        payload: { id: NS, metadata: {} }
      });
    });

    it('POST /resolve - should resolve a simple hierarchy', async () => {
      // Create units (IDs are generated by server)
      const createResp = await fastify.inject({
        method: 'POST',
        url: '/units',
        payload: [
          { label: 'Root', payload: { type: 'container' } },
          { label: 'Child', payload: { type: 'item' } }
        ]
      });

      expect(createResp.statusCode).toBe(201);
      const units = JSON.parse(createResp.payload);
      const rootId = units[0].id;
      const childId = units[1].id;

      // Link them
      await fastify.inject({
        method: 'POST',
        url: '/matrix/link',
        payload: {
          namespace: NS,
          source: rootId,
          verb: 'UNIT',
          target: childId,
          order: 1
        }
      });

      // Resolve
      const response = await fastify.inject({
        method: 'POST',
        url: '/resolve',
        payload: {
          namespace: NS,
          unit_id: rootId
        }
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.hierarchy).not.toBeNull();
      expect(body.hierarchy.id).toBe(rootId);
      expect(body.hierarchy.label).toBe('Root');
      expect(body.hierarchy.children).toHaveLength(1);
      expect(body.hierarchy.children[0].label).toBe('Child');
    });

    it('POST /resolve - should return 404 for non-existent namespace', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/resolve',
        payload: {
          namespace: 'no_such_ns',
          unit_id: makeId('any')
        }
      });

      expect(response.statusCode).toBe(404);
    });

    it('POST /resolve - should include operations when requested', async () => {
      const createResp = await fastify.inject({
        method: 'POST',
        url: '/units',
        payload: [{ label: 'Logged Unit', payload: {} }]
      });

      const units = JSON.parse(createResp.payload);
      const unitId = units[0].id;

      const response = await fastify.inject({
        method: 'POST',
        url: '/resolve',
        payload: {
          namespace: NS,
          unit_id: unitId,
          include_ops: true
        }
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.operations).toBeDefined();
      expect(body.operations.length).toBeGreaterThan(0);
    });

    it('POST /resolve - should apply HIDE verb', async () => {
      const createResp = await fastify.inject({
        method: 'POST',
        url: '/units',
        payload: [
          { label: 'Parent', payload: {} },
          { label: 'Visible', payload: {} },
          { label: 'Hidden', payload: {} }
        ]
      });

      const units = JSON.parse(createResp.payload);
      const parentId = units[0].id;
      const visibleId = units[1].id;
      const hiddenId = units[2].id;

      // Link both children
      await fastify.inject({
        method: 'POST',
        url: '/matrix/link',
        payload: { namespace: NS, source: parentId, verb: 'UNIT', target: visibleId, order: 1 }
      });
      await fastify.inject({
        method: 'POST',
        url: '/matrix/link',
        payload: { namespace: NS, source: parentId, verb: 'UNIT', target: hiddenId, order: 2 }
      });

      // Hide one child
      await fastify.inject({
        method: 'POST',
        url: '/matrix/link',
        payload: { namespace: NS, source: parentId, verb: 'HIDE', target: hiddenId, order: 0 }
      });

      const response = await fastify.inject({
        method: 'POST',
        url: '/resolve',
        payload: { namespace: NS, unit_id: parentId }
      });

      const body = JSON.parse(response.payload);
      expect(body.hierarchy.children).toHaveLength(1);
      expect(body.hierarchy.children[0].label).toBe('Visible');
    });

    it('POST /resolve - should apply REPLACE verb', async () => {
      const createResp = await fastify.inject({
        method: 'POST',
        url: '/units',
        payload: [
          { label: 'Parent', payload: {} },
          { label: 'Original', payload: { version: 'old' } },
          { label: 'Replacement', payload: { version: 'new' } }
        ]
      });

      const units = JSON.parse(createResp.payload);
      const parentId = units[0].id;
      const originalId = units[1].id;
      const replacementId = units[2].id;

      // Link original as child
      await fastify.inject({
        method: 'POST',
        url: '/matrix/link',
        payload: { namespace: NS, source: parentId, verb: 'UNIT', target: originalId, order: 1 }
      });

      // Replace original with replacement
      await fastify.inject({
        method: 'POST',
        url: '/matrix/link',
        payload: {
          namespace: NS,
          source: parentId,
          verb: 'REPLACE',
          target: originalId,
          order: 0,
          verb_value: replacementId
        }
      });

      const response = await fastify.inject({
        method: 'POST',
        url: '/resolve',
        payload: { namespace: NS, unit_id: parentId }
      });

      const body = JSON.parse(response.payload);
      expect(body.hierarchy.children).toHaveLength(1);
      expect(body.hierarchy.children[0].id).toBe(replacementId);
      expect(body.hierarchy.children[0].original_id).toBe(originalId);
      expect(body.hierarchy.children[0].payload.version).toBe('new');
    });
  });
});
