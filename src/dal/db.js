import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';

// FORCE load env here so the Pool isn't empty when Vitest starts
const envFile = process.env.NODE_ENV === 'test' ? '.env.test' : '.env';
dotenv.config({ path: path.resolve(process.cwd(), envFile) });

const { Pool } = pg;

export const db = new Pool({
  user: String(process.env.DB_USER),
  host: String(process.env.DB_HOST),
  database: String(process.env.DB_NAME),
  password: String(process.env.DB_PASSWORD),
  port: Number(process.env.DB_PORT),
});

export const cleanDb = async () => {
  await db.query('TRUNCATE TABLE units RESTART IDENTITY CASCADE');
};

export const closeDb = async () => {
  await db.end();
};