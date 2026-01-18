const db = require('./db');

const createUnits = async (units) => {
  const query = `
    INSERT INTO units (id, label, payload)
    SELECT * FROM UNNEST($1::text[], $2::text[], $3::jsonb[])
    RETURNING *;
  `;
  const res = await db.query(query, [
    units.map(u => u.id),
    units.map(u => u.label),
    units.map(u => JSON.stringify(u.payload))
  ]);
  return res.rows;
};

const readUnits = async (ids) => {
  const query = 'SELECT * FROM units WHERE id = ANY($1)';
  const res = await db.query(query, [ids]);
  return res.rows;
};

const updateUnits = async (units) => {
  const query = `
    UPDATE units SET
      label = COALESCE(tmp.label, units.label)
    FROM (SELECT UNNEST($1::text[]) as id, UNNEST($2::text[]) as label) as tmp
    WHERE units.id = tmp.id;
  `;
  const res = await db.query(query, [
    units.map(u => u.id),
    units.map(u => u.label ?? null)
  ]);
  return res.rowCount;
};

const updatePayloads = async (updates) => {
  const query = `
    UPDATE units SET
      payload = payload || tmp.new_payload
    FROM (SELECT UNNEST($1::text[]) as id, UNNEST($2::jsonb[]) as new_payload) as tmp
    WHERE units.id = tmp.id;
  `;
  const res = await db.query(query, [
    updates.map(u => u.id),
    updates.map(u => JSON.stringify(u.payload ?? {}))
  ]);
  return res.rowCount;
};

const deleteBatch = async (ids) => {
  const res = await db.query('DELETE FROM units WHERE id = ANY($1)', [ids]);
  return res.rowCount;
};

module.exports = {
  createUnits,
  readUnits,
  updateUnits,
  updatePayloads,
  deleteBatch
};