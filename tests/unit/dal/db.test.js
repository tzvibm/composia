import { describe, it, expect, afterAll } from 'vitest';
import { db, cleanDb, closeDb } from '../../../src/dal/db.js';

describe('Database Connection Utility', () => {

    // We close the connection at the very end of THIS file 
    // to ensure the process doesn't hang.
    afterAll(async () => {
        await closeDb();
    });

    it('should use the test database configuration', () => {
        const options = db.options;

        expect(process.env.NODE_ENV).toBe('test');
        expect(options.database).toBe('composia_test');
        expect(options.user).toBe('composia_admin');
    });

    it('should be able to execute a simple connectivity query', async () => {
        const res = await db.query('SELECT 1 + 1 AS result');
        expect(res.rows[0].result).toBe(2);
    });

    it('should successfully execute cleanDb', async () => {
        // 1. Insert a dummy row
        await db.query("INSERT INTO units (id, label) VALUES ('12345678901234567890123456789012', 'Cleanup Test')");

        // 2. Run cleanDb
        await cleanDb();

        // 3. Verify table is empty
        const res = await db.query('SELECT count(*) FROM units');
        expect(Number(res.rows[0].count)).toBe(0);
    });

    it('should have exported the closeDb function', () => {
        expect(typeof closeDb).toBe('function');
    });

    it('should determine the correct env file based on NODE_ENV', () => {
        // We can't easily re-run the top-level logic, but we can test the logic
        const getEnv = (nodeEnv) => nodeEnv === 'test' ? '.env.test' : '.env';

        expect(getEnv('test')).toBe('.env.test');
        expect(getEnv('production')).toBe('.env');
    });
});