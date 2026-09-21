'use strict';

const { pool } = require('../config/db');

/**
 * Reference-only saved card metadata for a customer. There is no full
 * card number or CVV anywhere in this model or its table — see the
 * comment above `customer_payment_methods` in database/schema.sql for
 * why that's a deliberate, structural choice, not an oversight.
 */

async function forCustomer(customerUserId) {
  const [rows] = await pool.execute(
    'SELECT * FROM customer_payment_methods WHERE customer_user_id = ? ORDER BY is_default DESC, created_at DESC',
    [customerUserId]
  );
  return rows;
}

async function findById(id) {
  const [rows] = await pool.execute('SELECT * FROM customer_payment_methods WHERE id = ?', [id]);
  return rows[0] || null;
}

async function countForCustomer(customerUserId) {
  const [rows] = await pool.execute(
    'SELECT COUNT(*) AS n FROM customer_payment_methods WHERE customer_user_id = ?',
    [customerUserId]
  );
  return rows[0].n;
}

async function create(customerUserId, data) {
  // First card a customer saves becomes their default automatically.
  const existing = await countForCustomer(customerUserId);
  const isDefault = existing === 0;
  const [result] = await pool.execute(
    `INSERT INTO customer_payment_methods
       (customer_user_id, card_brand, last4, expiry_month, expiry_year, cardholder_name, is_default)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [customerUserId, data.card_brand, data.last4, data.expiry_month, data.expiry_year, data.cardholder_name, isDefault ? 1 : 0]
  );
  return result.insertId;
}

/** Ownership-checked delete — returns false if the card isn't the caller's. */
async function remove(id, customerUserId) {
  const [result] = await pool.execute(
    'DELETE FROM customer_payment_methods WHERE id = ? AND customer_user_id = ?',
    [id, customerUserId]
  );
  return result.affectedRows > 0;
}

/** Ownership-checked — clears every other card's default flag first. */
async function setDefault(id, customerUserId) {
  const card = await findById(id);
  if (!card || card.customer_user_id !== customerUserId) return false;
  await pool.execute('UPDATE customer_payment_methods SET is_default = 0 WHERE customer_user_id = ?', [customerUserId]);
  await pool.execute('UPDATE customer_payment_methods SET is_default = 1 WHERE id = ?', [id]);
  return true;
}

module.exports = { forCustomer, findById, countForCustomer, create, remove, setDefault };
