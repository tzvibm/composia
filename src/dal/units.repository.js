import { db } from './db.js';

export const createUnits = async (units) => {
  const query = `
    INSERT INTO units (id, label, payload)
    SELECT * FROM UNNEST($1::text[], $2::text[], $3::jsonb[])
    RETURNING *;
  `;
  const res = await db.query(query, [
    units.map(u => u.id),
    units.map(u => u.label),
    units.map(u => u.payload || {}) 
  ]);
  return res.rows;
};


export const readUnits = async (ids) => {
  const query = 'SELECT * FROM units WHERE id = ANY($1::text[])';
  const res = await db.query(query, [ids]);
  return res.rows;
};


export const updateUnits = async (units) => {
  const query = `
    UPDATE units SET
      label = COALESCE(tmp.label, units.label)
    FROM (SELECT UNNEST($1::text[]) as id, UNNEST($2::text[]) as label) as tmp
    WHERE units.id = tmp.id
    RETURNING units.*;  -- <--- This returns the full updated rows
  `;
  
  const res = await db.query(query, [
    units.map(u => u.id),
    units.map(u => u.label ?? null)
  ]);
  
  return res.rows;
};


export const updatePayloads = async (updates) => {
  const query = `
    UPDATE units SET
      payload = payload || tmp.new_payload
    FROM (SELECT UNNEST($1::text[]) as id, UNNEST($2::jsonb[]) as new_payload) as tmp
    WHERE units.id = tmp.id
    RETURNING units.*; -- Return the full object after the merge
  `;
  const res = await db.query(query, [
    updates.map(u => u.id),
    updates.map(u => u.payload ?? {})
  ]);
  return res.rows;
};

export const deleteBatch = async (ids) => {
  // We use RETURNING id to get back the specific keys that were deleted
  const query = 'DELETE FROM units WHERE id = ANY($1::text[]) RETURNING id';
  const res = await db.query(query, [ids]);
  
  return {
    deleted: res.rows.map(row => row.id),
    count: res.rowCount
  };
};