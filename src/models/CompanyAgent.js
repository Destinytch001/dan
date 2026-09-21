'use strict';

const { pool } = require('../config/db');

/**
 * A company's realtor roster. agent_profiles.company_id is the live
 * source of truth for who is currently attached (see AgentProfile.js);
 * company_agents is the join/leave audit trail (schema.sql had this
 * table from day one, but nothing ever wrote to it until now — no
 * signup flow, admin action, or route anywhere set an agent's
 * company_id, so every agent has been "independent" by default this
 * whole build). This module is the first real place that changes.
 *
 * Attaching/detaching an agent here is staff-initiated and consent-free
 * by design, the same way a company records a completed purchase or
 * rental on a customer's behalf (see purchases/rentals modules) rather
 * than the customer clicking a checkout button — the real join/leave
 * happens outside the app (an employment or contractor agreement), and
 * this just records it. The one guardrail that matters here is
 * integrity, not consent: a company can only attach an agent who is
 * currently independent (company_id IS NULL), so one company can never
 * silently poach another's agent out from under it.
 */

async function listRoster(companyId) {
  const [rows] = await pool.execute(
    `SELECT u.id AS user_id, u.email, u.phone, ap.full_name, ap.avatar_path,
            ap.verification_status,
            (SELECT MAX(ca.joined_at) FROM company_agents ca
              WHERE ca.agent_id = u.id AND ca.company_id = ? AND ca.status = 'active') AS joined_at,
            (SELECT COUNT(*) FROM properties p
              WHERE p.listed_by_user_id = u.id AND p.deleted_at IS NULL) AS property_count
     FROM agent_profiles ap
     JOIN users u ON u.id = ap.user_id
     WHERE ap.company_id = ?
     ORDER BY ap.full_name ASC`,
    [companyId, companyId]
  );
  return rows;
}

/**
 * Same roster as listRoster, plus a real customer_count per agent
 * (distinct customers across their own purchases/rentals/viewings —
 * mirrors what Contact.forLister counts, just aggregated per agent
 * instead of returning the contact rows themselves), for the Realtor
 * Ranking page. Two correlated subqueries per row rather than a single
 * UNION+GROUP — the roster size for one company is small enough that
 * this stays cheap and easy to follow.
 */
async function ranking(companyId) {
  const [rows] = await pool.execute(
    `SELECT u.id AS user_id, u.email, ap.full_name, ap.avatar_path,
            (SELECT COUNT(*) FROM properties p
              WHERE p.listed_by_user_id = u.id AND p.deleted_at IS NULL) AS property_count,
            (
              SELECT COUNT(DISTINCT customer_user_id) FROM (
                SELECT pp.buyer_user_id AS customer_user_id FROM property_purchases pp
                  JOIN properties p ON p.id = pp.property_id WHERE p.listed_by_user_id = u.id
                UNION ALL
                SELECT pr.tenant_user_id FROM property_rentals pr
                  JOIN properties p ON p.id = pr.property_id WHERE p.listed_by_user_id = u.id
                UNION ALL
                SELECT pv.customer_user_id FROM property_viewings pv
                  JOIN properties p ON p.id = pv.property_id WHERE p.listed_by_user_id = u.id
              ) deals
            ) AS customer_count
     FROM agent_profiles ap
     JOIN users u ON u.id = ap.user_id
     WHERE ap.company_id = ?
     ORDER BY customer_count DESC, property_count DESC
     LIMIT 20`,
    [companyId]
  );
  return rows;
}

/** True once the target user is a real, currently-independent agent. */
async function findAttachableAgentByEmail(email) {
  const [rows] = await pool.execute(
    `SELECT u.id AS user_id, u.email, u.role, ap.company_id, ap.full_name
     FROM users u
     JOIN agent_profiles ap ON ap.user_id = u.id
     WHERE u.email = ? LIMIT 1`,
    [email]
  );
  return rows[0] || null;
}

async function attach(companyId, agentUserId) {
  await pool.execute('UPDATE agent_profiles SET company_id = ? WHERE user_id = ?', [companyId, agentUserId]);
  await pool.execute(
    `INSERT INTO company_agents (company_id, agent_id, status, joined_at) VALUES (?, ?, 'active', NOW())`,
    [companyId, agentUserId]
  );
}

/** True if this agent currently belongs to this company (IDOR check before remove/reassign). */
async function isActiveMember(companyId, agentUserId) {
  const [rows] = await pool.execute(
    'SELECT 1 FROM agent_profiles WHERE user_id = ? AND company_id = ? LIMIT 1',
    [agentUserId, companyId]
  );
  return rows.length > 0;
}

async function remove(companyId, agentUserId) {
  await pool.execute('UPDATE agent_profiles SET company_id = NULL WHERE user_id = ? AND company_id = ?', [
    agentUserId,
    companyId,
  ]);
  await pool.execute(
    `UPDATE company_agents SET status = 'removed', left_at = NOW()
      WHERE company_id = ? AND agent_id = ? AND status = 'active'`,
    [companyId, agentUserId]
  );
}

module.exports = { listRoster, ranking, findAttachableAgentByEmail, attach, isActiveMember, remove };
