'use strict';

const crypto = require('crypto');
const { pool } = require('../config/db');

/**
 * Company → agent invites. Agents can no longer self-register as
 * independent — see auth.routes.js's signup gate — so this is now the
 * only door in: a company adds an email (the person doesn't need an
 * account yet), and POST /auth/signup with role='agent' checks here for
 * a pending invite matching the email before it will create the
 * account, auto-attaching to the inviting company the moment the agent
 * finishes signing up. CompanyAgent.attach()/findAttachableAgentByEmail
 * still cover the other case — a company adding an agent who already
 * has an independent account from before this rule existed.
 */

/**
 * @returns {Promise<{id: number, token: string}>} the token is the
 * public identifier used in the onboarding link emailed to the invited
 * realtor (see company-agents.routes.js) -- it is NOT the row id, so
 * an invite can never be enumerated/guessed by walking sequential ids.
 */
async function create(executor, companyId, email, invitedByUserId) {
  const token = crypto.randomBytes(24).toString('hex');
  const [result] = await (executor || pool).execute(
    `INSERT INTO company_agent_invites (company_id, email, token, invited_by, status)
     VALUES (?, ?, ?, ?, 'pending')`,
    [companyId, email, token, invitedByUserId]
  );
  return { id: result.insertId, token };
}

async function findPendingForCompanyAndEmail(companyId, email) {
  const [rows] = await pool.execute(
    `SELECT * FROM company_agent_invites WHERE company_id = ? AND email = ? AND status = 'pending' LIMIT 1`,
    [companyId, email]
  );
  return rows[0] || null;
}

/** Most recent pending invite for an email, across any company — the signup gate. */
async function findPendingByEmail(email) {
  const [rows] = await pool.execute(
    `SELECT * FROM company_agent_invites WHERE email = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
    [email]
  );
  return rows[0] || null;
}

/**
 * Public lookup by token -- backs GET /company-agents/invites/:token,
 * the ONLY route in this module with no requireAuth/requireRole, since
 * the person opening the onboarding link doesn't have an account yet.
 * Joins the company's name in directly so the onboarding page can show
 * "You've been invited to join <Company> as a Realtor" without a second
 * round trip or exposing any other company/agent data through the token.
 */
async function findPendingByToken(token) {
  const [rows] = await pool.execute(
    `SELECT cai.id, cai.email, cai.company_id, cai.status, c.company_name
       FROM company_agent_invites cai
       JOIN companies c ON c.id = cai.company_id
      WHERE cai.token = ? AND cai.status = 'pending'
      LIMIT 1`,
    [token]
  );
  return rows[0] || null;
}

async function listPendingForCompany(companyId) {
  const [rows] = await pool.execute(
    `SELECT id, email, created_at FROM company_agent_invites
      WHERE company_id = ? AND status = 'pending' ORDER BY created_at DESC`,
    [companyId]
  );
  return rows;
}

/** IDOR-checked: only the inviting company can revoke its own pending invite. */
async function revoke(id, companyId) {
  const [result] = await pool.execute(
    `UPDATE company_agent_invites SET status = 'revoked' WHERE id = ? AND company_id = ? AND status = 'pending'`,
    [id, companyId]
  );
  return result.affectedRows > 0;
}

async function accept(executor, id, acceptedByUserId) {
  await (executor || pool).execute(
    `UPDATE company_agent_invites SET status = 'accepted', accepted_by = ?, accepted_at = NOW() WHERE id = ?`,
    [acceptedByUserId, id]
  );
}

/**
 * Best-effort cleanup after acceptance: if more than one company had a
 * pending invite out for this email, the others are now moot — leaving
 * them "pending" forever would just be confusing clutter in each
 * company's invite list.
 */
async function expireOtherPendingForEmail(email, exceptId) {
  await pool.execute(
    `UPDATE company_agent_invites SET status = 'expired' WHERE email = ? AND status = 'pending' AND id != ?`,
    [email, exceptId]
  );
}

module.exports = {
  create,
  findPendingForCompanyAndEmail,
  findPendingByEmail,
  findPendingByToken,
  listPendingForCompany,
  revoke,
  accept,
  expireOtherPendingForEmail,
};
