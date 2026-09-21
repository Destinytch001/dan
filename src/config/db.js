'use strict';

const mysql = require('mysql2/promise');
const { env } = require('./env');

// A connection pool, not a single connection — safe under concurrent
// requests, which a single shared mysql2 Connection is not. Every query
// in this codebase uses parameterized placeholders (`?`) via
// pool.execute(sql, params), which mysql2 sends as a real prepared
// statement — never string-concatenated SQL. That's the whole SQL
// injection defense, and it only works if every call site follows it.
//
// dateStrings: true — DATETIME/TIMESTAMP columns come back as plain
// "YYYY-MM-DD HH:MM:SS" strings instead of JS Date objects. This is
// deliberate: mysql2's `timezone` option only controls how it PARSES
// values into a Date client-side — it does NOT change what timezone the
// MySQL server itself is computing NOW()/DATE_ADD() in. If those two
// disagree (e.g. this app assumes UTC but the shared-hosting MySQL
// server's system timezone is something else), every expiry check —
// OTP codes, refresh tokens, account lockouts, rate limits — silently
// computes against the wrong instant. The PHP version of this backend
// hit exactly this bug in testing. The fix here is two-fold: force the
// session to UTC on every connection (below) AND prefer comparing
// expiry in SQL itself (`WHERE expires_at > UTC_TIMESTAMP()`) over
// fetching a timestamp and comparing it in JS.
const pool = mysql.createPool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  database: env.DB_NAME,
  user: env.DB_USER,
  password: env.DB_PASS,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4_general_ci',
  dateStrings: true,
  decimalNumbers: false, // keep DECIMAL columns (money!) as strings, never lossy JS floats
});

console.log(`[HouseBank] Initializing MySQL pool for ${env.DB_HOST}:${env.DB_PORT}/${env.DB_NAME}`);

pool.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('[HouseBank] MySQL pool error:', err.message);
});

// Force every pooled connection's session timezone to UTC, regardless of
// the MySQL server's own system timezone setting.
pool.on('connection', (connection) => {
  // eslint-disable-next-line no-console
  console.log(`[HouseBank] MySQL connection opened: ${env.DB_HOST}:${env.DB_PORT}/${env.DB_NAME}`);
  connection.query("SET time_zone = '+00:00'", (err) => {
    if (err) {
      // eslint-disable-next-line no-console
      console.error('[HouseBank] Failed to set session time_zone to UTC:', err.message);
    }
  });
});

async function verifyDatabaseConnection() {
  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.execute('SELECT 1 AS ok');
    if (!rows || rows.length === 0 || rows[0].ok !== 1) {
      throw new Error('Unexpected DB ping response');
    }
    // eslint-disable-next-line no-console
    console.log(`[HouseBank] DB connectivity check passed: SELECT 1 => ${rows[0].ok}`);
    return true;
  } finally {
    connection.release();
  }
}

/**
 * Run `callback(connection)` inside a transaction with automatic
 * commit/rollback. Use this for any multi-statement write that must be
 * all-or-nothing (e.g. creating a user + their role profile together).
 */
async function withTransaction(callback) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await callback(connection);
    await connection.commit();
    return result;
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

module.exports = { pool, withTransaction, verifyDatabaseConnection };
