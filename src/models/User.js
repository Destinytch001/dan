'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('../config/db');

function uuid() {
  return crypto.randomUUID();
}

async function findByEmail(email) {
  const [rows] = await pool.execute('SELECT * FROM users WHERE email = ? AND deleted_at IS NULL LIMIT 1', [email]);
  return rows[0] || null;
}

async function findByPhone(phone) {
  const [rows] = await pool.execute('SELECT * FROM users WHERE phone = ? AND deleted_at IS NULL LIMIT 1', [phone]);
  return rows[0] || null;
}

/** Accepts either an email or a Nigerian phone number as the login identifier. */
async function findByIdentifier(identifier) {
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier)) {
    return findByEmail(identifier);
  }
  return findByPhone(identifier);
}

async function findById(id) {
  const [rows] = await pool.execute('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL LIMIT 1', [id]);
  return rows[0] || null;
}

async function findByIdIncludingDeleted(id) {
  const [rows] = await pool.execute('SELECT * FROM users WHERE id = ? LIMIT 1', [id]);
  return rows[0] || null;
}

async function create(connection, { email, phone, password, role }) {
  const passwordHash = await bcrypt.hash(password, 12);
  const [result] = await connection.execute(
    `INSERT INTO users (uuid, email, phone, password_hash, role, status)
     VALUES (?, ?, ?, ?, ?, 'pending_verification')`,
    [uuid(), email, phone, passwordHash, role]
  );
  return result.insertId;
}

async function markEmailVerified(userId) {
  await pool.execute(
    `UPDATE users SET email_verified_at = NOW(),
       status = IF(status = 'pending_verification', 'active', status)
     WHERE id = ?`,
    [userId]
  );
}

async function deleteById(userId) {
  await pool.execute('DELETE FROM users WHERE id = ?', [userId]);
}

async function softDelete(userId) {
  await pool.execute(
    `UPDATE users
       SET deleted_at = NOW(),
           updated_at = NOW()
     WHERE id = ? AND deleted_at IS NULL`,
    [userId]
  );
}

async function restoreDeleted(userId) {
  await pool.execute(
    `UPDATE users
       SET deleted_at = NULL,
           status = 'active',
           updated_at = NOW()
     WHERE id = ?`,
    [userId]
  );
}

async function updatePasswordHash(userId, newPassword) {
  const passwordHash = await bcrypt.hash(newPassword, 12);
  await pool.execute('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, userId]);
}

async function recordSuccessfulLogin(userId, ip) {
  await pool.execute(
    'UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = NOW(), last_login_ip = ? WHERE id = ?',
    [ip, userId]
  );
}

/**
 * Increments the failed-login counter and locks the account for an
 * escalating cool-off once the threshold is hit — the account-level
 * defense that complements IP-based rate limiting (one attacker can
 * still spread attempts across many IPs against a single account).
 */
async function registerFailedLogin(userId) {
  await pool.execute('UPDATE users SET failed_login_count = failed_login_count + 1 WHERE id = ?', [userId]);
  const [rows] = await pool.execute('SELECT failed_login_count FROM users WHERE id = ?', [userId]);
  const count = rows[0] ? rows[0].failed_login_count : 0;

  if (count >= 5) {
    const lockMinutes = Math.min(60, 5 * 2 ** (count - 5)); // 5, 10, 20, 40, 60...
    await pool.execute('UPDATE users SET locked_until = DATE_ADD(NOW(), INTERVAL ? MINUTE) WHERE id = ?', [
      lockMinutes,
      userId,
    ]);
  }
}

function isLocked(user) {
  if (!user.locked_until) return false;
  // dateStrings:true (see config/db.js) returns "YYYY-MM-DD HH:MM:SS" in
  // UTC (the session is forced to UTC). Converting the space to 'T' and
  // appending 'Z' makes it an unambiguous ISO-8601 UTC instant for Date.
  const utcIso = user.locked_until.replace(' ', 'T') + 'Z';
  return new Date(utcIso).getTime() > Date.now();
}

/**
 * The users table itself has no name column by design — full_name lives
 * on whichever role-profile table actually owns it (customer_profiles /
 * agent_profiles / companies.company_name), so it can't drift out of
 * sync with a signup form the way a duplicated column could. This is
 * the one place that resolves "whichever table" back into a single
 * display name for the frontend.
 */
async function getDisplayName(user) {
  if (!user) return null;
  if (user.role === 'customer') {
    const [rows] = await pool.execute('SELECT full_name FROM customer_profiles WHERE user_id = ?', [user.id]);
    return rows[0] ? rows[0].full_name : null;
  }
  if (user.role === 'agent') {
    const [rows] = await pool.execute('SELECT full_name FROM agent_profiles WHERE user_id = ?', [user.id]);
    return rows[0] ? rows[0].full_name : null;
  }
  if (user.role === 'company') {
    const [rows] = await pool.execute('SELECT company_name FROM companies WHERE user_id = ?', [user.id]);
    return rows[0] ? rows[0].company_name : null;
  }
  return null; // admin — no profile table, nothing to resolve
}

function toPublicObject(user, displayName = null) {
  return {
    id: user.id,
    uuid: user.uuid,
    email: user.email,
    phone: user.phone,
    role: user.role,
    status: user.status,
    email_verified: user.email_verified_at !== null,
    full_name: displayName,
    two_factor_enabled: user.two_factor_enabled_at !== null && user.two_factor_enabled_at !== undefined,
  };
}

/**
 * Admin account-status toggle (Joan, Sep 2026 admin-pages tranche --
 * used by the realtor/customer management pages). Deliberately not
 * usable on an 'admin' account from the route layer -- see
 * admin.routes.js's guard -- so one admin can't lock another out this
 * way. 'suspended' is already enforced at signin and refresh (see
 * auth.routes.js), so this has real teeth, not just a cosmetic label.
 */
async function setStatus(userId, status) {
  await pool.execute('UPDATE users SET status = ? WHERE id = ?', [status, userId]);
}

/**
 * Admin's own profile picture (migration 014). Admin has no profile
 * table like every other role does, so its avatar lives directly on
 * users -- this is the admin-only counterpart to
 * CustomerProfile.updateAvatar / AgentProfile.updateAvatar /
 * Company.updateLogo.
 */
async function updateAvatar(userId, avatarPath) {
  await pool.execute('UPDATE users SET avatar_path = ? WHERE id = ?', [avatarPath, userId]);
}

module.exports = {
  uuid,
  findByEmail,
  findByPhone,
  findByIdentifier,
  findById,
  findByIdIncludingDeleted,
  create,
  markEmailVerified,
  deleteById,
  softDelete,
  restoreDeleted,
  updatePasswordHash,
  recordSuccessfulLogin,
  registerFailedLogin,
  isLocked,
  toPublicObject,
  getDisplayName,
  setStatus,
  updateAvatar,
};
