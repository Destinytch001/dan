'use strict';

const crypto = require('crypto');
const { pool } = require('../config/db');

async function create(connection, { investor_user_id, investment_property_id, amount }) {
  const executor = connection || pool;
  const [result] = await executor.execute(
    `INSERT INTO investments (uuid, investor_user_id, investment_property_id, amount, status)
     VALUES (?, ?, ?, ?, 'pending_payment')`,
    [crypto.randomUUID(), investor_user_id, investment_property_id, amount]
  );
  return result.insertId;
}

async function findById(id) {
  const [rows] = await pool.execute('SELECT * FROM investments WHERE id = ?', [id]);
  return rows[0] || null;
}

async function forInvestor(userId) {
  const [rows] = await pool.execute(
    `SELECT i.*, ip.expected_roi_percent, ip.tenure_months, ip.maturity_date,
            p.id AS property_id, p.title AS property_title, p.address, p.city, p.state,
            c.company_name, ap.full_name AS realtor_name,
            (SELECT file_path FROM property_images pi WHERE pi.property_id = p.id ORDER BY is_primary DESC, sort_order ASC LIMIT 1) AS cover_image
     FROM investments i
     JOIN investment_properties ip ON ip.id = i.investment_property_id
     JOIN properties p ON p.id = ip.property_id
     LEFT JOIN companies c ON c.id = p.company_id
     LEFT JOIN agent_profiles ap ON ap.user_id = p.listed_by_user_id AND p.company_id IS NULL
     WHERE i.investor_user_id = ?
     ORDER BY i.created_at DESC`,
    [userId]
  );
  return rows;
}

/**
 * Aggregate stats for the dashboard's "Investment Stats" card. Computed
 * in SQL, not fetched-then-summed in JS. DECIMAL sums come back as
 * strings (decimalNumbers:false in config/db.js, deliberate — see that
 * file's comment on money precision), parsed once here at the boundary.
 */
async function statsForInvestor(userId) {
  const [rows] = await pool.execute(
    `SELECT
       COALESCE(SUM(CASE WHEN i.status IN ('active','matured') THEN i.amount ELSE 0 END), 0) AS total_invested,
       COALESCE(SUM(CASE WHEN i.status IN ('active','matured') THEN i.amount * ip.expected_roi_percent / 100 ELSE 0 END), 0) AS estimated_returns,
       COUNT(CASE WHEN i.status IN ('active','matured') THEN 1 END) AS active_count
     FROM investments i
     JOIN investment_properties ip ON ip.id = i.investment_property_id
     WHERE i.investor_user_id = ?`,
    [userId]
  );
  const row = rows[0];
  return {
    total_invested: Number(row.total_invested),
    estimated_returns: Number(row.estimated_returns),
    active_count: Number(row.active_count),
  };
}

async function markActive(connection, id) {
  const executor = connection || pool;
  await executor.execute(
    `UPDATE investments SET status = 'active', invested_at = NOW() WHERE id = ? AND status = 'pending_payment'`,
    [id]
  );
}

module.exports = { create, findById, forInvestor, statsForInvestor, markActive };
