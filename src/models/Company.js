'use strict';

const { pool } = require('../config/db');

async function create(executor, userId, companyName, companyAddress, cacNumber, cacDocumentPath) {
  const [result] = await (executor || pool).execute(
    `INSERT INTO companies (user_id, company_name, company_address, cac_number, cac_document_path)
     VALUES (?, ?, ?, ?, ?)`,
    [userId, companyName, companyAddress, cacNumber, cacDocumentPath]
  );
  return result.insertId;
}

async function findByUserId(userId) {
  const [rows] = await pool.execute('SELECT * FROM companies WHERE user_id = ?', [userId]);
  return rows[0] || null;
}

async function findById(id) {
  const [rows] = await pool.execute('SELECT * FROM companies WHERE id = ?', [id]);
  return rows[0] || null;
}

async function updateLogo(userId, logoPath) {
  await pool.execute('UPDATE companies SET logo_path = ? WHERE user_id = ?', [logoPath, userId]);
}

/**
 * Public directory listing (see modules/companies/companies.routes.js).
 * Verified companies surface first (a real trust signal, not just a
 * cosmetic badge), then newest. Never filters out unverified/pending --
 * they're flagged client-side with the same "Unverified" pill already
 * used on property cards, not hidden.
 */
async function listPublic({ page, perPage, q }) {
  const where = [];
  const params = [];
  if (q) {
    where.push('c.company_name LIKE ?');
    params.push(`%${q}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [countRows] = await pool.execute(`SELECT COUNT(*) AS total FROM companies c ${whereSql}`, params);
  const total = countRows[0].total;

  const offset = Math.max(0, (page - 1) * perPage);
  // LIMIT/OFFSET inlined as parseInt-derived integers only -- same
  // documented exception as Property.searchApproved, never raw request text.
  const [rows] = await pool.query(
    `SELECT c.id, c.company_name, c.company_address, c.logo_path, c.verification_status, c.created_at,
            (SELECT COUNT(*) FROM properties p WHERE p.company_id = c.id AND p.status = 'approved' AND p.deleted_at IS NULL) AS property_count,
            (SELECT COUNT(*) FROM agent_profiles ap WHERE ap.company_id = c.id) AS agent_count
     FROM companies c
     ${whereSql}
     ORDER BY (c.verification_status = 'verified') DESC, c.created_at DESC
     LIMIT ${Number(perPage)} OFFSET ${Number(offset)}`,
    params
  );

  return { items: rows, total, page, per_page: perPage };
}

/** Public single-company profile (see modules/companies/companies.routes.js). */
async function findPublicById(id) {
  const [rows] = await pool.execute(
    `SELECT c.id, c.company_name, c.company_address, c.logo_path, c.verification_status, c.created_at,
            (SELECT COUNT(*) FROM properties p WHERE p.company_id = c.id AND p.status = 'approved' AND p.deleted_at IS NULL) AS property_count,
            (SELECT COUNT(*) FROM agent_profiles ap WHERE ap.company_id = c.id) AS agent_count
     FROM companies c
     WHERE c.id = ?`,
    [id]
  );
  return rows[0] || null;
}

/**
 * Admin verification queue (Joan, Sep 2026: "a company can just
 * register at any time, but must be verified... the admin only vets
 * and approves companies"). Pending-first ordering so the newest
 * unverified registrations surface at the top of admin's queue.
 */
async function listForAdmin({ status, q } = {}, page = 1, perPage = 20) {
  const where = [];
  const params = [];
  if (status) {
    where.push('c.verification_status = ?');
    params.push(status);
  }
  if (q) {
    where.push('(c.company_name LIKE ? OR u.email LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS total FROM companies c JOIN users u ON u.id = c.user_id WHERE u.deleted_at IS NULL ${whereSql ? `AND ${whereSql.replace(/^WHERE /, '')}` : ''}`,
    params
  );
  const total = countRows[0].total;

  const offset = Math.max(0, (page - 1) * perPage);
  const [rows] = await pool.query(
    `SELECT c.id, c.company_name, c.company_address, c.cac_number, c.verification_status,
            c.verification_notes, c.verified_at, c.logo_path, c.created_at,
            u.id AS user_id, u.email, u.phone, u.status AS account_status,
            (SELECT COUNT(*) FROM properties p WHERE p.company_id = c.id AND p.deleted_at IS NULL) AS property_count,
            (SELECT COUNT(*) FROM company_agents ca WHERE ca.company_id = c.id AND ca.status = 'active') AS realtor_count
     FROM companies c
     JOIN users u ON u.id = c.user_id
     WHERE u.deleted_at IS NULL ${whereSql ? `AND ${whereSql.replace(/^WHERE /, '')}` : ''}
     ORDER BY (c.verification_status = 'pending') DESC, c.created_at DESC
     LIMIT ${Number(perPage)} OFFSET ${Number(offset)}`,
    params
  );

  return { items: rows, total, page, per_page: perPage };
}

/** Admin single-company detail -- includes the private cac_number/cac_document_path fields listPublic/findPublicById deliberately omit. */
async function findByIdForAdmin(id) {
  const [rows] = await pool.execute(
    `SELECT c.*, u.email, u.phone, u.status AS account_status, u.created_at AS account_created_at
     FROM companies c JOIN users u ON u.id = c.user_id WHERE c.id = ? AND u.deleted_at IS NULL`,
    [id]
  );
  return rows[0] || null;
}

async function verify(id, adminUserId, notes) {
  await pool.execute(
    "UPDATE companies SET verification_status = 'verified', verification_notes = ?, verified_by = ?, verified_at = NOW() WHERE id = ?",
    [notes || null, adminUserId, id]
  );
}

async function rejectVerification(id, adminUserId, notes) {
  await pool.execute(
    "UPDATE companies SET verification_status = 'rejected', verification_notes = ?, verified_by = ?, verified_at = NOW() WHERE id = ?",
    [notes, adminUserId, id]
  );
}

module.exports = {
  create,
  findByUserId,
  findById,
  updateLogo,
  listPublic,
  findPublicById,
  listForAdmin,
  findByIdForAdmin,
  verify,
  rejectVerification,
};
