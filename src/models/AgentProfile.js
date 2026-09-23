'use strict';

const { pool } = require('../config/db');

// company_id is deliberately excluded — that's managed only through the
// company/agent-transfer flow (company_agents, realtor_transfer_requests),
// never by the agent editing their own profile.
const UPDATABLE_FIELDS = ['full_name', 'bio'];

async function create(executor, userId, fullName, idDocumentPath, companyId = null) {
  await (executor || pool).execute(
    'INSERT INTO agent_profiles (user_id, full_name, id_document_path, company_id) VALUES (?, ?, ?, ?)',
    [userId, fullName, idDocumentPath, companyId]
  );
}

async function findByUserId(userId) {
  const [rows] = await pool.execute('SELECT * FROM agent_profiles WHERE user_id = ?', [userId]);
  return rows[0] || null;
}

/**
 * Agent profile joined with the company they currently work for (if any),
 * so a single call gives the profile page everything it needs to show
 * "works for <Company Name>" without a second round trip.
 */
async function findByUserIdWithCompany(userId) {
  const [rows] = await pool.execute(
    `SELECT ap.*,
            c.id AS company_id_resolved,
            c.company_name,
            c.logo_path AS company_logo_path,
            c.verification_status AS company_verification_status
     FROM agent_profiles ap
     LEFT JOIN companies c ON c.id = ap.company_id
     WHERE ap.user_id = ?`,
    [userId]
  );
  return rows[0] || null;
}

async function updateFields(userId, fields) {
  const keys = Object.keys(fields).filter((k) => UPDATABLE_FIELDS.includes(k));
  if (keys.length === 0) return false;
  const setClause = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => fields[k]);
  await pool.execute(`UPDATE agent_profiles SET ${setClause} WHERE user_id = ?`, [...values, userId]);
  return true;
}

async function updateAvatar(userId, avatarPath) {
  await pool.execute('UPDATE agent_profiles SET avatar_path = ? WHERE user_id = ?', [avatarPath, userId]);
}

/**
 * A single company's public roster (see modules/companies/companies.routes.js
 * GET /companies/:id/agents). Only verification_status is exposed as a
 * trust signal -- id_document_path stays private, same as everywhere else.
 */
async function listPublicForCompany(companyId) {
  const [rows] = await pool.execute(
    `SELECT ap.user_id, ap.full_name, ap.avatar_path, ap.bio, ap.verification_status,
            ap.rating_avg, ap.rating_count,
            (SELECT COUNT(*) FROM properties p
              WHERE p.listed_by_user_id = ap.user_id AND p.status = 'approved' AND p.deleted_at IS NULL) AS property_count
     FROM agent_profiles ap
     WHERE ap.company_id = ?
     ORDER BY ap.full_name ASC`,
    [companyId]
  );
  return rows;
}

/**
 * Flat, cross-company "Find an Agent" directory (see
 * modules/agents/agents.routes.js). Every agent here is expected to
 * belong to a company under the mandatory company-agent model, but the
 * LEFT JOIN and null-safe fields tolerate the pre-rule-change rows too.
 */
async function listPublic({ page, perPage, q, companyId }) {
  const where = [];
  const params = [];
  if (q) {
    where.push('ap.full_name LIKE ?');
    params.push(`%${q}%`);
  }
  if (companyId) {
    where.push('ap.company_id = ?');
    params.push(Number(companyId));
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [countRows] = await pool.execute(`SELECT COUNT(*) AS total FROM agent_profiles ap ${whereSql}`, params);
  const total = countRows[0].total;

  const offset = Math.max(0, (page - 1) * perPage);
  // LIMIT/OFFSET inlined as parseInt-derived integers only -- same
  // documented exception used across the other public list queries.
  const [rows] = await pool.query(
    `SELECT ap.user_id, ap.full_name, ap.avatar_path, ap.bio, ap.verification_status,
            ap.rating_avg, ap.rating_count, ap.company_id,
            c.company_name, c.logo_path AS company_logo_path, c.verification_status AS company_verification_status,
            (SELECT COUNT(*) FROM properties p
              WHERE p.listed_by_user_id = ap.user_id AND p.status = 'approved' AND p.deleted_at IS NULL) AS property_count
     FROM agent_profiles ap
     LEFT JOIN companies c ON c.id = ap.company_id
     ${whereSql}
     ORDER BY ap.full_name ASC
     LIMIT ${Number(perPage)} OFFSET ${Number(offset)}`,
    params
  );

  return { items: rows, total, page, per_page: perPage };
}

/**
 * Admin realtor directory (Joan, Sep 2026: "/admin/realtors" was
 * still static). Cross-company -- every realtor on the platform,
 * regardless of which company they're attached to (mandatory model,
 * so every row here has one).
 */
async function listForAdmin({ q, companyId, accountStatus } = {}, page = 1, perPage = 20) {
  const where = [];
  const params = [];
  if (q) {
    where.push('(ap.full_name LIKE ? OR u.email LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  if (companyId) {
    where.push('ap.company_id = ?');
    params.push(companyId);
  }
  if (accountStatus) {
    where.push('u.status = ?');
    params.push(accountStatus);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS total FROM agent_profiles ap JOIN users u ON u.id = ap.user_id ${whereSql}`,
    params
  );
  const total = countRows[0].total;

  const offset = Math.max(0, (page - 1) * perPage);
  const [rows] = await pool.query(
    `SELECT ap.user_id, ap.full_name, ap.avatar_path, ap.verification_status, ap.company_id,
            c.company_name, u.email, u.phone, u.status AS account_status, u.created_at,
            (SELECT COUNT(*) FROM properties p WHERE p.listed_by_user_id = ap.user_id AND p.deleted_at IS NULL) AS property_count
     FROM agent_profiles ap
     JOIN users u ON u.id = ap.user_id
     LEFT JOIN companies c ON c.id = ap.company_id
     ${whereSql}
     ORDER BY u.created_at DESC
     LIMIT ${Number(perPage)} OFFSET ${Number(offset)}`,
    params
  );

  return { items: rows, total, page, per_page: perPage };
}

module.exports = {
  create,
  findByUserId,
  findByUserIdWithCompany,
  updateFields,
  updateAvatar,
  UPDATABLE_FIELDS,
  listPublicForCompany,
  listPublic,
  listForAdmin,
};
