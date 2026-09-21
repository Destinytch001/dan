'use strict';

const { pool } = require('../config/db');

/**
 * A company/realtor's appeal against an admin block on one of their
 * listings (Joan, Sep 2026: "block a property in which the company
 * will/must appeal"). Mirrors the existing findPending/approve/reject
 * pattern properties.routes.js and admin.routes.js already use for
 * listing review -- admin works a queue here too, rather than being
 * pinged per row (consistent with how pending-listing review already
 * works, see findPending in Property.js).
 */
async function create(propertyId, userId, message) {
  const [result] = await pool.execute(
    `INSERT INTO property_appeals (property_id, submitted_by_user_id, message) VALUES (?, ?, ?)`,
    [propertyId, userId, message]
  );
  return result.insertId;
}

async function hasPending(propertyId) {
  const [rows] = await pool.execute(
    "SELECT id FROM property_appeals WHERE property_id = ? AND status = 'pending' LIMIT 1",
    [propertyId]
  );
  return rows.length > 0;
}

async function findForProperty(propertyId) {
  const [rows] = await pool.execute(
    `SELECT id, message, status, admin_response, resolved_at, created_at
     FROM property_appeals WHERE property_id = ? ORDER BY created_at DESC`,
    [propertyId]
  );
  return rows;
}

async function findPendingForAdmin(page, perPage) {
  const [countRows] = await pool.execute("SELECT COUNT(*) AS total FROM property_appeals WHERE status = 'pending'");
  const total = countRows[0].total;

  const offset = Math.max(0, (page - 1) * perPage);
  const [rows] = await pool.query(
    `SELECT pa.id, pa.property_id, pa.message, pa.created_at,
            p.title AS property_title, p.blocked_reason,
            u.email AS submitted_by_email, COALESCE(c.company_name, ap.full_name) AS submitted_by_name
     FROM property_appeals pa
     JOIN properties p ON p.id = pa.property_id
     JOIN users u ON u.id = pa.submitted_by_user_id
     LEFT JOIN companies c ON c.user_id = u.id
     LEFT JOIN agent_profiles ap ON ap.user_id = u.id
     WHERE pa.status = 'pending'
     ORDER BY pa.created_at ASC
     LIMIT ${Number(perPage)} OFFSET ${Number(offset)}`
  );
  return { items: rows, total, page, per_page: perPage };
}

async function findById(id) {
  const [rows] = await pool.execute('SELECT * FROM property_appeals WHERE id = ? LIMIT 1', [id]);
  return rows[0] || null;
}

async function resolve(id, adminUserId, decision, adminResponse) {
  await pool.execute(
    'UPDATE property_appeals SET status = ?, admin_response = ?, resolved_by = ?, resolved_at = NOW() WHERE id = ?',
    [decision, adminResponse || null, adminUserId, id]
  );
}

module.exports = { create, hasPending, findForProperty, findPendingForAdmin, findById, resolve };
