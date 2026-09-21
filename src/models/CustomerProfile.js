'use strict';

const { pool } = require('../config/db');

const UPDATABLE_FIELDS = ['full_name', 'address', 'city', 'state', 'date_of_birth'];

async function create(executor, userId, fullName) {
  await (executor || pool).execute('INSERT INTO customer_profiles (user_id, full_name) VALUES (?, ?)', [userId, fullName]);
}

async function findByUserId(userId) {
  const [rows] = await pool.execute('SELECT * FROM customer_profiles WHERE user_id = ?', [userId]);
  return rows[0] || null;
}

/**
 * Partial update — only fields explicitly whitelisted above can ever be
 * written here, regardless of what the caller passes in `fields`. Silently
 * ignores unknown keys rather than erroring, since the route layer already
 * filters before calling this, but a second gate here means a future route
 * bug can't turn into an arbitrary-column write.
 */
async function updateFields(userId, fields) {
  const keys = Object.keys(fields).filter((k) => UPDATABLE_FIELDS.includes(k));
  if (keys.length === 0) return false;
  const setClause = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => fields[k]);
  await pool.execute(`UPDATE customer_profiles SET ${setClause} WHERE user_id = ?`, [...values, userId]);
  return true;
}

async function updateAvatar(userId, avatarPath) {
  await pool.execute('UPDATE customer_profiles SET avatar_path = ? WHERE user_id = ?', [avatarPath, userId]);
}

/**
 * Admin customer directory (Joan, Sep 2026: "/admin/customers" was
 * still static). Purchase/rental/investment counts give admin a real
 * sense of activity without pulling in a whole transaction history.
 */
async function listForAdmin({ q, accountStatus } = {}, page = 1, perPage = 20) {
  const where = [];
  const params = [];
  if (q) {
    where.push('(cp.full_name LIKE ? OR u.email LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  if (accountStatus) {
    where.push('u.status = ?');
    params.push(accountStatus);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS total FROM customer_profiles cp JOIN users u ON u.id = cp.user_id ${whereSql}`,
    params
  );
  const total = countRows[0].total;

  const offset = Math.max(0, (page - 1) * perPage);
  const [rows] = await pool.query(
    `SELECT cp.user_id, cp.full_name, cp.avatar_path, cp.city, cp.state,
            u.email, u.phone, u.status AS account_status, u.created_at,
            (SELECT COUNT(*) FROM property_purchases pp WHERE pp.buyer_user_id = cp.user_id) AS purchase_count,
            (SELECT COUNT(*) FROM property_rentals pr WHERE pr.tenant_user_id = cp.user_id) AS rental_count,
            (SELECT COUNT(*) FROM investments i WHERE i.investor_user_id = cp.user_id) AS investment_count
     FROM customer_profiles cp
     JOIN users u ON u.id = cp.user_id
     ${whereSql}
     ORDER BY u.created_at DESC
     LIMIT ${Number(perPage)} OFFSET ${Number(offset)}`,
    params
  );

  return { items: rows, total, page, per_page: perPage };
}

module.exports = { create, findByUserId, updateFields, updateAvatar, UPDATABLE_FIELDS, listForAdmin };
