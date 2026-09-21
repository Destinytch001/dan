'use strict';

const crypto = require('crypto');
const { pool } = require('../config/db');

/**
 * A customer's outright purchase of a 'sale'-listing property. Mirrors
 * the investments module's pending -> confirmed pattern: this records
 * INTENT only (see purchases.routes.js), a separate confirm step (the
 * manual counterpart to a Paystack webhook) is what actually completes
 * the sale.
 */
async function create(connection, { buyer_user_id, property_id, agreed_price }) {
  const executor = connection || pool;
  const [result] = await executor.execute(
    `INSERT INTO property_purchases (uuid, buyer_user_id, property_id, agreed_price, status)
     VALUES (?, ?, ?, ?, 'pending_payment')`,
    [crypto.randomUUID(), buyer_user_id, property_id, agreed_price]
  );
  return result.insertId;
}

/**
 * A customer's own request to buy a property -- the customer-facing
 * front door onto the same flow `create` above powers for staff. Starts
 * at 'requested', not 'pending_payment': no Transaction row exists yet,
 * nothing has been agreed. See purchases.routes.js's POST /request and
 * POST /:id/approve.
 */
async function request(connection, { buyer_user_id, property_id, agreed_price }) {
  const executor = connection || pool;
  const [result] = await executor.execute(
    `INSERT INTO property_purchases (uuid, buyer_user_id, property_id, agreed_price, status)
     VALUES (?, ?, ?, ?, 'requested')`,
    [crypto.randomUUID(), buyer_user_id, property_id, agreed_price]
  );
  return result.insertId;
}

/** Stops the same buyer from stacking duplicate requests on a property
 * they already have an open (unresolved) request or purchase on. */
async function hasOpenRequest(buyerUserId, propertyId) {
  const [rows] = await pool.execute(
    `SELECT id FROM property_purchases
      WHERE buyer_user_id = ? AND property_id = ? AND status IN ('requested','pending_payment','processing')
      LIMIT 1`,
    [buyerUserId, propertyId]
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
    `UPDATE property_purchases SET status = 'pending_payment', staff_note = ?
      WHERE id = ? AND status = 'requested'`,
    [staffNote || null, id]
  );
}

/** Staff declines a customer's request. Terminal -- the customer is
 * free to submit a fresh request afterwards if they want to. */
async function decline(id, staffNote) {
  await pool.execute(
    `UPDATE property_purchases SET status = 'declined', staff_note = ?
      WHERE id = ? AND status = 'requested'`,
    [staffNote || null, id]
  );
}

/** A customer withdraws their own still-open request. Mirrors
 * PropertyViewing.cancel's ownership-checked, single-statement shape. */
async function cancelOwnRequest(id, buyerUserId) {
  const [result] = await pool.execute(
    `UPDATE property_purchases SET status = 'cancelled', cancelled_at = NOW()
      WHERE id = ? AND buyer_user_id = ? AND status = 'requested'`,
    [id, buyerUserId]
  );
  return result.affectedRows > 0;
}

async function findById(id) {
  const [rows] = await pool.execute('SELECT * FROM property_purchases WHERE id = ?', [id]);
  return rows[0] || null;
}

async function forBuyer(userId) {
  const [rows] = await pool.execute(
    `SELECT pp.*, p.title AS property_title, p.address, p.city, p.state,
            c.company_name, ap.full_name AS realtor_name,
            (SELECT file_path FROM property_images pi WHERE pi.property_id = p.id ORDER BY is_primary DESC, sort_order ASC LIMIT 1) AS cover_image
     FROM property_purchases pp
     JOIN properties p ON p.id = pp.property_id
     LEFT JOIN companies c ON c.id = p.company_id
     LEFT JOIN agent_profiles ap ON ap.user_id = p.listed_by_user_id AND p.company_id IS NULL
     WHERE pp.buyer_user_id = ?
     ORDER BY pp.created_at DESC`,
    [userId]
  );
  return rows;
}

async function complete(connection, id) {
  const executor = connection || pool;
  await executor.execute(
    `UPDATE property_purchases SET status = 'completed', completed_at = NOW()
     WHERE id = ? AND status IN ('pending_payment','processing')`,
    [id]
  );
}

/** Once a sale completes, any other still-pending intent on the same
 * property is stale — a property can only sell once. */
async function cancelOtherPending(connection, propertyId, exceptId) {
  const executor = connection || pool;
  await executor.execute(
    `UPDATE property_purchases SET status = 'cancelled', cancelled_at = NOW()
     WHERE property_id = ? AND id != ? AND status IN ('pending_payment','processing')`,
    [propertyId, exceptId]
  );
}

/**
 * All purchases against properties this user (agent/company) lists —
 * powers Agent Revenue/Transactions. Not a security boundary by
 * itself (the route enforces role + "this is really me"); this just
 * returns the join.
 */
// companyId is optional — a company account passes its own id so this
// also includes purchases against properties its agents list, not just
// ones the company listed itself. See Property.findByListerId for the
// same pattern.
async function forLister(userId, companyId = null, status = null) {
  let sql = `SELECT pp.*, p.title AS property_title, p.address, p.city, p.state,
            cp.full_name AS buyer_name, cp.avatar_path AS buyer_avatar
     FROM property_purchases pp
     JOIN properties p ON p.id = pp.property_id
     LEFT JOIN customer_profiles cp ON cp.user_id = pp.buyer_user_id
     WHERE (p.listed_by_user_id = ?`;
  const params = [userId];
  if (companyId) {
    sql += ' OR p.company_id = ?';
    params.push(companyId);
  }
  sql += ')';
  if (status) {
    sql += ' AND pp.status = ?';
    params.push(status);
  }
  sql += ' ORDER BY pp.created_at DESC';
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
  forBuyer,
  forLister,
  complete,
  cancelOtherPending,
  cancelOwnRequest,
};
