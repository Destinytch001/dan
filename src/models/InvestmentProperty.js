'use strict';

const { pool } = require('../config/db');

/**
 * findOpen: the public investment-opportunity directory (Joan, Sep 2026
 * -- "you haven't fixed /investment"). Was already a real, working,
 * boot-tested endpoint (GET /investments/opportunities) -- the gap was
 * entirely on the frontend, which never called it and showed 4
 * hardcoded properties instead. Extended here with the same filters the
 * public property search already supports (status, a free-text `q`
 * against city/state/title, and a min/max band on the investment's
 * min_investment_amount) so the real Investment page's search box has
 * something real to call, plus `company_verification_status` so the
 * same Unverified badge used everywhere else on the public site can
 * apply here too.
 */
async function findOpen({ page = 1, perPage = 12, status, q, min_amount, max_amount } = {}) {
  const where = [];
  const params = [];

  if (status) {
    where.push('ip.status = ?');
    params.push(status);
  } else {
    // Default view: anything still raising or fully funded -- not a
    // closed/matured investment that no longer belongs on a "browse
    // opportunities" page.
    where.push("ip.status IN ('open','fully_funded')");
  }
  if (q) {
    where.push('(p.title LIKE ? OR p.city LIKE ? OR p.state LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (min_amount) {
    where.push('ip.min_investment_amount >= ?');
    params.push(Number(min_amount));
  }
  if (max_amount) {
    where.push('ip.min_investment_amount <= ?');
    params.push(Number(max_amount));
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const offset = Math.max(0, (page - 1) * perPage);

  const [rows] = await pool.query(
    `SELECT ip.*, p.title, p.city, p.state, p.address, p.company_id,
            c.company_name, c.verification_status AS company_verification_status,
            (SELECT file_path FROM property_images pi WHERE pi.property_id = p.id ORDER BY is_primary DESC, sort_order ASC LIMIT 1) AS cover_image
     FROM investment_properties ip
     JOIN properties p ON p.id = ip.property_id
     LEFT JOIN companies c ON c.id = p.company_id
     ${whereSql}
     ORDER BY ip.created_at DESC
     LIMIT ${Number(perPage)} OFFSET ${Number(offset)}`,
    params
  );
  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS total
     FROM investment_properties ip
     JOIN properties p ON p.id = ip.property_id
     ${whereSql}`,
    params
  );
  return { data: rows, page, per_page: perPage, total: countRows[0].total };
}

async function findById(id) {
  const [rows] = await pool.execute(
    `SELECT ip.*, p.title, p.description, p.city, p.state, p.address, p.listed_by_user_id, p.company_id,
            c.company_name, c.company_address, c.logo_path, c.verification_status AS company_verification_status
     FROM investment_properties ip
     JOIN properties p ON p.id = ip.property_id
     LEFT JOIN companies c ON c.id = p.company_id
     WHERE ip.id = ?`,
    [id]
  );
  return rows[0] || null;
}

/**
 * findByPropertyId: backs the public property-details page's "Invest"
 * button (Joan, Sep 2026 -- "fix the Invest"). A property's Invest CTA
 * was scrolling to the generic viewing form regardless of listing type,
 * because there was no way for the frontend to look up whether a real
 * investment_properties row even exists for that property. Returns
 * whichever row exists for this property_id (there should be at most
 * one), any status -- the frontend decides what to show for
 * fully_funded/closed/matured rather than this ever 404-ing behind a
 * status filter.
 */
async function findByPropertyId(propertyId) {
  const [rows] = await pool.execute(
    `SELECT ip.*, p.title, p.city, p.state, p.address
     FROM investment_properties ip
     JOIN properties p ON p.id = ip.property_id
     WHERE ip.property_id = ?
     ORDER BY ip.id DESC
     LIMIT 1`,
    [propertyId]
  );
  return rows[0] || null;
}

async function create({ property_id, total_target_amount, min_investment_amount, expected_roi_percent, tenure_months, maturity_date }) {
  const [result] = await pool.execute(
    `INSERT INTO investment_properties
       (property_id, total_target_amount, min_investment_amount, expected_roi_percent, tenure_months, maturity_date)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [property_id, total_target_amount, min_investment_amount, expected_roi_percent, tenure_months, maturity_date || null]
  );
  return result.insertId;
}

async function addToAmountRaised(id, amount) {
  await pool.execute(
    `UPDATE investment_properties
       SET amount_raised = amount_raised + ?,
           status = IF(amount_raised + ? >= total_target_amount, 'fully_funded', status)
     WHERE id = ?`,
    [amount, amount, id]
  );
}

module.exports = { findOpen, findById, findByPropertyId, create, addToAmountRaised };
