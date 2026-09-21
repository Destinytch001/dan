'use strict';

const { pool } = require('../config/db');

/**
 * Backs admin's review-moderation inbox (Joan, Sep 2026: "fix ...
 * http://localhost:5173/admin/reviews"). The `reviews` table (rating,
 * reviewee_type/reviewee_id, status) has existed in schema.sql since
 * early in the build, but nothing ever wrote to it — there is no
 * review-submission surface anywhere in the app yet (no "leave a
 * review" button on a customer/agent/company page). That's a separate,
 * larger gap than what Joan asked for here; this makes the moderation
 * side real and honest (a real empty state until reviews actually
 * exist) rather than building a submission flow nobody asked for.
 *
 * reviewee_id is polymorphic and has no FK (the schema itself has no
 * CHECK/FK tying it to a specific table), so this resolves it the same
 * way every other cross-role lookup in this codebase does: an agent by
 * agent_profiles.user_id (the convention Contact/Conversation both use
 * for agents), a company by companies.id (the convention
 * properties.company_id/incident_reports.company_id both use), a
 * property by properties.id.
 */

const REVIEWER_JOIN = `
  LEFT JOIN customer_profiles rcp ON rcp.user_id = r.reviewer_user_id
  LEFT JOIN agent_profiles rap ON rap.user_id = r.reviewer_user_id
  LEFT JOIN companies rc ON rc.user_id = r.reviewer_user_id
`;
const REVIEWEE_JOIN = `
  LEFT JOIN agent_profiles eap ON r.reviewee_type = 'agent' AND eap.user_id = r.reviewee_id
  LEFT JOIN companies ec ON r.reviewee_type = 'company' AND ec.id = r.reviewee_id
  LEFT JOIN properties ep ON r.reviewee_type = 'property' AND ep.id = r.reviewee_id
`;
const SELECT_FIELDS = `
  r.id, r.reviewer_user_id, r.reviewee_type, r.reviewee_id, r.rating, r.comment, r.status, r.created_at,
  u.email AS reviewer_email,
  COALESCE(rcp.full_name, rap.full_name, rc.company_name, u.email) AS reviewer_name,
  COALESCE(eap.full_name, ec.company_name, ep.title) AS reviewee_name
`;

async function list({ status, reviewee_type, page = 1, perPage = 20 } = {}) {
  const where = [];
  const params = [];
  if (status) {
    where.push('r.status = ?');
    params.push(status);
  }
  if (reviewee_type) {
    where.push('r.reviewee_type = ?');
    params.push(reviewee_type);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const offset = Math.max(0, (page - 1) * perPage);

  const [countRows] = await pool.query(`SELECT COUNT(*) AS total FROM reviews r ${whereSql}`, params);
  const [rows] = await pool.query(
    `SELECT ${SELECT_FIELDS}
       FROM reviews r
       JOIN users u ON u.id = r.reviewer_user_id
       ${REVIEWER_JOIN}
       ${REVIEWEE_JOIN}
       ${whereSql}
      ORDER BY r.created_at DESC
      LIMIT ${Number(perPage)} OFFSET ${Number(offset)}`,
    params
  );
  return { items: rows, total: countRows[0].total, page, per_page: perPage };
}

async function updateStatus(id, status) {
  await pool.execute('UPDATE reviews SET status = ? WHERE id = ?', [status, id]);
}

async function remove(id) {
  await pool.execute('DELETE FROM reviews WHERE id = ?', [id]);
}

module.exports = { list, updateStatus, remove };
