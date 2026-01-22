import { describe, it, expect } from 'vitest';
import { generateHash32 } from '../../../src/utils/id.js';

describe('ID Utility', () => {
  it('should generate a string of exactly 32 characters', () => {
    const id = generateHash32();
    expect(id).toHaveLength(32);
  });

  it('should only contain hexadecimal characters', () => {
    const id = generateHash32();
    expect(id).toMatch(/^[a-f0-9]{32}$/);
  });

  it('should produce the same hash for the same seed', () => {
    const seed = 'test-seed';
    const hash1 = generateHash32(seed);
    const hash2 = generateHash32(seed);
    expect(hash1).toBe(hash2);
  });

  it('should produce different hashes for different seeds', () => {
    const hash1 = generateHash32('seed-1');
    const hash2 = generateHash32('seed-2');
    expect(hash1).not.toBe(hash2);
  });
});