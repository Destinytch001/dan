'use strict';

const crypto = require('crypto');
const { pool } = require('../config/db');

/**
 * A customer's request to view a property in person with an agent —
 * the actual entry point into buying/renting/selling at HouseBank,
 * which happens at the office rather than through self-service
 * checkout (see property_purchases/property_rentals — those are now
 * created by staff after this in-person process, not by the customer).
 */
async function create(data) {
  const [result] = await pool.execute(
    `INSERT INTO property_viewings
       (uuid, customer_user_id, property_id, preferred_date, preferred_time, full_name, phone, message, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'requested')`,
    [
      crypto.randomUUID(),
      data.customer_user_id,
      data.property_id,
      data.preferred_date,
      data.preferred_time || null,
      data.full_name,
      data.phone,
      data.message || null,
    ]
  );
  return result.insertId;
}

async function findById(id) {
  const [rows] = await pool.execute('SELECT * FROM property_viewings WHERE id = ?', [id]);
  return rows[0] || null;
}

async function forCustomer(userId) {
  const [rows] = await pool.execute(
    `SELECT v.*, p.title AS property_title, p.address, p.city, p.state,
            c.company_name, ap.full_name AS realtor_name,
            (SELECT file_path FROM property_images pi WHERE pi.property_id = p.id ORDER BY is_primary DESC, sort_order ASC LIMIT 1) AS cover_image
     FROM property_viewings v
     JOIN properties p ON p.id = v.property_id
     LEFT JOIN companies c ON c.id = p.company_id
     LEFT JOIN agent_profiles ap ON ap.user_id = p.listed_by_user_id AND p.company_id IS NULL
     WHERE v.customer_user_id = ?
     ORDER BY v.created_at DESC`,
    [userId]
  );
  return rows;
}

async function confirm(id, staffUserId, scheduledAt) {
  await pool.execute(
    `UPDATE property_viewings
        SET status = 'confirmed', handled_by = ?, scheduled_at = ?
      WHERE id = ? AND status = 'requested'`,
    [staffUserId, scheduledAt, id]
  );
}

async function complete(id, staffUserId) {
  await pool.execute(
    `UPDATE property_viewings SET status = 'completed', handled_by = ? WHERE id = ? AND status = 'confirmed'`,
    [staffUserId, id]
  );
}

async function cancel(id, customerUserId) {
  const [result] = await pool.execute(
    `UPDATE property_viewings SET status = 'cancelled'
     WHERE id = ? AND customer_user_id = ? AND status IN ('requested','confirmed')`,
    [id, customerUserId]
  );
  return result.affectedRows > 0;
}

/**
 * All viewing requests against properties this user (agent/company)
 * lists — this is the piece that was missing entirely: staff had no
 * way to even SEE a request before this, only to confirm/complete one
 * by ID via curl. Optional status filter (e.g. 'requested') so the
 * dashboard can show "needs your action" separately from history.
 */
// companyId is optional — same reasoning as PropertyPurchase.forLister.
async function forLister(userId, status, companyId = null) {
  const params = [userId];
  let ownerClause = 'p.listed_by_user_id = ?';
  if (companyId) {
    ownerClause = '(p.listed_by_user_id = ? OR p.company_id = ?)';
    params.push(companyId);
  }
  let statusClause = '';
  if (status) {
    statusClause = ' AND v.status = ?';
    params.push(status);
  }
  const [rows] = await pool.execute(
    `SELECT v.*, p.title AS property_title, p.address, p.city, p.state,
            cp.full_name AS customer_name, cp.avatar_path AS customer_avatar
     FROM property_viewings v
     JOIN properties p ON p.id = v.property_id
     LEFT JOIN customer_profiles cp ON cp.user_id = v.customer_user_id
     WHERE ${ownerClause}${statusClause}
     ORDER BY v.created_at DESC`,
    params
  );
  return rows;
}

module.exports = { create, findById, forCustomer, forLister, confirm, complete, cancel };
