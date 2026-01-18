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