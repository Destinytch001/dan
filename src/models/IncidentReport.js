'use strict';

const { pool } = require('../config/db');

/**
 * Backs the two public "report" forms: /report-concern (neighbourhood
 * concern, optionally about a named company) and /report-scam (fraud/
 * scam report, always admin-visible). Both anonymous -- no account
 * required to file either.
 */

async function create(data) {
  const [result] = await pool.execute(
    `INSERT INTO incident_reports
       (type, company_id, reporter_full_name, reporter_email, reporter_phone, incident_date, description,
        scammer_name, scammer_email, scammer_phone, money_lost, amount_lost, ip_address)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.type,
      data.company_id || null,
      data.reporter_full_name || null,
      data.reporter_email || null,
      data.reporter_phone || null,
      data.incident_date || null,
      data.description,
      data.scammer_name || null,
      data.scammer_email || null,
      data.scammer_phone || null,
      data.money_lost === undefined || data.money_lost === null ? null : data.money_lost ? 1 : 0,
      data.amount_lost || null,
      data.ip_address || null,
    ]
  );
  return result.insertId;
}

async function list({ type, status, page = 1, perPage = 30 }) {
  const where = [];
  const params = [];
  if (type) {
    where.push('ir.type = ?');
    params.push(type);
  }
  if (status) {
    where.push('ir.status = ?');
    params.push(status);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const offset = Math.max(0, (page - 1) * perPage);

  const [countRows] = await pool.execute(`SELECT COUNT(*) AS total FROM incident_reports ir ${whereSql}`, params);
  // LEFT JOIN companies so admin sees which company a neighbourhood-concern
  // report is about by name, not just a bare company_id (scam reports have
  // no company_id and c.company_name comes back null for those, which is
  // correct -- scams are reported against a person, not a listed company).
  const [rows] = await pool.query(
    `SELECT ir.*, c.company_name
     FROM incident_reports ir
     LEFT JOIN companies c ON c.id = ir.company_id
     ${whereSql}
     ORDER BY ir.created_at DESC
     LIMIT ${Number(perPage)} OFFSET ${Number(offset)}`,
    params
  );
  return { items: rows, total: countRows[0].total, page, per_page: perPage };
}

async function listForCompany(companyId, page = 1, perPage = 30) {
  const offset = Math.max(0, (page - 1) * perPage);
  const [countRows] = await pool.execute(
    "SELECT COUNT(*) AS total FROM incident_reports WHERE type = 'neighbourhood_concern' AND company_id = ?",
    [companyId]
  );
  const [rows] = await pool.query(
    `SELECT id, reporter_full_name, incident_date, description, status, created_at
     FROM incident_reports
     WHERE type = 'neighbourhood_concern' AND company_id = ?
     ORDER BY created_at DESC
     LIMIT ${Number(perPage)} OFFSET ${Number(offset)}`,
    [companyId]
  );
  return { items: rows, total: countRows[0].total, page, per_page: perPage };
}

async function updateStatus(id, status) {
  await pool.execute('UPDATE incident_reports SET status = ? WHERE id = ?', [status, id]);
}

/**
 * Aggregate counts feeding the admin Reports chart (Joan, Sep 2026:
 * "I didn't see the graphs and charts anymore" — the page this replaced
 * had a fabricated bar chart on fake data; this is the real version,
 * same AreaChart/PieChart pattern AdminStats.propertiesTrend/
 * topCompanies already use for /admin/overview).
 */
async function stats(months = 6) {
  const [trendRows] = await pool.query(
    `SELECT DATE_FORMAT(created_at, '%Y-%m') AS ym, DATE_FORMAT(created_at, '%b') AS month,
            SUM(type = 'neighbourhood_concern') AS concerns, SUM(type = 'scam') AS scams
       FROM incident_reports
      WHERE created_at >= CURDATE() - INTERVAL ? MONTH
      GROUP BY ym, month
      ORDER BY ym ASC`,
    [months]
  );
  const [statusRows] = await pool.query(
    `SELECT status, COUNT(*) AS count FROM incident_reports GROUP BY status`
  );
  const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM incident_reports');

  return {
    trend: trendRows.map((r) => ({ month: r.month, concerns: Number(r.concerns), scams: Number(r.scams) })),
    by_status: statusRows.map((r) => ({ status: r.status, count: Number(r.count) })),
    total,
  };
}

module.exports = { create, list, listForCompany, updateStatus, stats };
