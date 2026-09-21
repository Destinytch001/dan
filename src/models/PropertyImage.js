'use strict';

const { pool } = require('../config/db');

async function add(propertyId, filePath, isPrimary, sortOrder) {
  const [result] = await pool.execute(
    'INSERT INTO property_images (property_id, file_path, is_primary, sort_order) VALUES (?, ?, ?, ?)',
    [propertyId, filePath, isPrimary ? 1 : 0, sortOrder]
  );
  return result.insertId;
}

async function forProperty(propertyId) {
  const [rows] = await pool.execute(
    'SELECT * FROM property_images WHERE property_id = ? ORDER BY is_primary DESC, sort_order ASC',
    [propertyId]
  );
  return rows;
}

async function countForProperty(propertyId) {
  const [rows] = await pool.execute('SELECT COUNT(*) AS total FROM property_images WHERE property_id = ?', [
    propertyId,
  ]);
  return rows[0].total;
}

module.exports = { add, forProperty, countForProperty };
