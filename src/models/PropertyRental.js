'use strict';

const crypto = require('crypto');
const { pool } = require('../config/db');

/**
 * A customer's lease of a 'rent'-listing property. Rent is modeled as a
 * single upfront payment for the whole lease term (rent_amount * months)
 * rather than recurring billing — matching how rent is actually paid in
 * the Nigerian market this platform targets, and avoiding building a
 * subscription/recurring-charge system that hasn't been asked for.
 */
async function create(connection, { tenant_user_id, property_id, rent_amount, rent_period_months }) {
  const executor = connection || pool;
  const [result] = await executor.execute(
    `INSERT INTO property_rentals (uuid, tenant_user_id, property_id, rent_amount, rent_period_months, status)
     VALUES (?, ?, ?, ?, ?, 'pending_payment')`,
    [crypto.randomUUID(), tenant_user_id, property_id, rent_amount, rent_period_months]
  );
  return result.insertId;
}

/**
 * A customer's own request to rent a property -- customer-facing front
 * door onto the same flow `create` above powers for staff. Starts at
 * 'requested': no Transaction row yet, nothing agreed. See
 * rentals.routes.js's POST /request and POST /:id/approve.
 */
async function request(connection, { tenant_user_id, property_id, rent_amount, rent_period_months }) {
  const executor = connection || pool;
  const [result] = await executor.execute(
    `INSERT INTO property_rentals (uuid, tenant_user_id, property_id, rent_amount, rent_period_months, status)
     VALUES (?, ?, ?, ?, ?, 'requested')`,
    [crypto.randomUUID(), tenant_user_id, property_id, rent_amount, rent_period_months]
  );
  return result.insertId;
}

/** Stops the same tenant from stacking duplicate requests on a property
 * they already have an open (unresolved) request or rental on. */
async function hasOpenRequest(tenantUserId, propertyId) {
  const [rows] = await pool.execute(
    `SELECT id FROM property_rentals
      WHERE tenant_user_id = ? AND property_id = ? AND status IN ('requested','pending_payment')
      LIMIT 1`,
    [tenantUserId, propertyId]
  );
  return rows.length > 0;
}

/** Staff approves a customer's request -- promotes it to the same
 * 'pending_payment' state `create` above starts at directly, so
 * everything downstream (confirm, cancelOtherPending) treats it
 * identically regardless of how it was recorded. */
async function approve(connection, id, staffNote) {
  const executor = connection || pool;
  await executor.execute(
    `UPDATE property_rentals SET status = 'pending_payment', staff_note = ?
      WHERE id = ? AND status = 'requested'`,
    [staffNote || null, id]
  );
}

/** Staff declines a customer's request. Terminal -- the customer is
 * free to submit a fresh request afterwards if they want to. */
async function decline(id, staffNote) {
  await pool.execute(
    `UPDATE property_rentals SET status = 'declined', staff_note = ?
      WHERE id = ? AND status = 'requested'`,
    [staffNote || null, id]
  );
}

/** A tenant withdraws their own still-open request. Mirrors
 * PropertyViewing.cancel's ownership-checked, single-statement shape. */
async function cancelOwnRequest(id, tenantUserId) {
  const [result] = await pool.execute(
    `UPDATE property_rentals SET status = 'cancelled', cancelled_at = NOW()
      WHERE id = ? AND tenant_user_id = ? AND status = 'requested'`,
    [id, tenantUserId]
  );
  return result.affectedRows > 0;
}

async function findById(id) {
  const [rows] = await pool.execute('SELECT * FROM property_rentals WHERE id = ?', [id]);
  return rows[0] || null;
}

async function forTenant(userId) {
  const [rows] = await pool.execute(
    `SELECT pr.*, p.title AS property_title, p.address, p.city, p.state,
            c.company_name, ap.full_name AS realtor_name,
            (SELECT file_path FROM property_images pi WHERE pi.property_id = p.id ORDER BY is_primary DESC, sort_order ASC LIMIT 1) AS cover_image
     FROM property_rentals pr
     JOIN properties p ON p.id = pr.property_id
     LEFT JOIN companies c ON c.id = p.company_id
     LEFT JOIN agent_profiles ap ON ap.user_id = p.listed_by_user_id AND p.company_id IS NULL
     WHERE pr.tenant_user_id = ?
     ORDER BY pr.created_at DESC`,
    [userId]
  );
  return rows;
}

async function activate(connection, id, periodMonths) {
  const executor = connection || pool;
  await executor.execute(
    `UPDATE property_rentals
        SET status = 'active', lease_start_date = CURDATE(),
            lease_end_date = DATE_ADD(CURDATE(), INTERVAL ? MONTH)
      WHERE id = ? AND status = 'pending_payment'`,
    [periodMonths, id]
  );
}

/** Once a lease activates, any other still-pending intent on the same
 * property is stale — a property can only be actively leased to one
 * tenant at a time. */
async function cancelOtherPending(connection, propertyId, exceptId) {
  const executor = connection || pool;
  await executor.execute(
    `UPDATE property_rentals SET status = 'cancelled', cancelled_at = NOW()
     WHERE property_id = ? AND id != ? AND status = 'pending_payment'`,
    [propertyId, exceptId]
  );
}

/**
 * All rentals against properties this user (agent/company) lists —
 * powers Agent Revenue/Transactions, same shape as
 * PropertyPurchase.forLister.
 */
// companyId is optional — same reasoning as PropertyPurchase.forLister.
async function forLister(userId, companyId = null, status = null) {
  let sql = `SELECT pr.*, p.title AS property_title, p.address, p.city, p.state,
            cp.full_name AS tenant_name, cp.avatar_path AS tenant_avatar
     FROM property_rentals pr
     JOIN properties p ON p.id = pr.property_id
     LEFT JOIN customer_profiles cp ON cp.user_id = pr.tenant_user_id
     WHERE (p.listed_by_user_id = ?`;
  const params = [userId];
  if (companyId) {
    sql += ' OR p.company_id = ?';
    params.push(companyId);
  }
  sql += ')';
  if (status) {
    sql += ' AND pr.status = ?';
    params.push(status);
  }
  sql += ' ORDER BY pr.created_at DESC';
  const [rows] = await pool.execute(sql, params);
  return rows;
}

module.exports = {
  create,
  request,
  hasOpenRequest,
  approve,
  decline,
  findById,
  forTenant,
  forLister,
  activate,
  cancelOtherPending,
  cancelOwnRequest,
};
