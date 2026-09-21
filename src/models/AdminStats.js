'use strict';

const { pool } = require('../config/db');

/**
 * Real numbers for the admin overview dashboard (Joan, Sep 2026: admin
 * pages were "still static" -- Overview.tsx was hardcoded sample data
 * with no backend behind it at all). Every query here is a plain
 * aggregate against the live tables -- nothing cached, nothing
 * hardcoded, everything DB-driven per the standing brief.
 */
async function counts() {
  const [[{ total_properties }]] = await pool.query(
    "SELECT COUNT(*) AS total_properties FROM properties WHERE deleted_at IS NULL"
  );
  const [[{ total_companies }]] = await pool.query(
    "SELECT COUNT(*) AS total_companies FROM users WHERE role = 'company' AND deleted_at IS NULL"
  );
  const [[{ total_realtors }]] = await pool.query(
    "SELECT COUNT(*) AS total_realtors FROM users WHERE role = 'agent' AND deleted_at IS NULL"
  );
  const [[{ total_customers }]] = await pool.query(
    "SELECT COUNT(*) AS total_customers FROM users WHERE role = 'customer' AND deleted_at IS NULL"
  );
  return {
    total_properties,
    total_companies,
    total_realtors,
    total_customers,
  };
}

/** Percentage change in new signups this calendar month vs last -- the platform-growth stat card. */
async function platformGrowth() {
  const [[{ this_month }]] = await pool.query(
    `SELECT COUNT(*) AS this_month FROM users
     WHERE deleted_at IS NULL AND YEAR(created_at) = YEAR(CURDATE()) AND MONTH(created_at) = MONTH(CURDATE())`
  );
  const [[{ last_month }]] = await pool.query(
    `SELECT COUNT(*) AS last_month FROM users
     WHERE deleted_at IS NULL
       AND YEAR(created_at) = YEAR(CURDATE() - INTERVAL 1 MONTH)
       AND MONTH(created_at) = MONTH(CURDATE() - INTERVAL 1 MONTH)`
  );
  if (last_month === 0) return this_month > 0 ? 100 : 0;
  return Math.round(((this_month - last_month) / last_month) * 1000) / 10;
}

/** Properties listed per month, most recent `months` months, oldest first -- feeds the trend chart. */
async function propertiesTrend(months = 7) {
  const [rows] = await pool.query(
    `SELECT DATE_FORMAT(created_at, '%Y-%m') AS ym, DATE_FORMAT(created_at, '%b') AS month, COUNT(*) AS value
     FROM properties
     WHERE deleted_at IS NULL AND created_at >= CURDATE() - INTERVAL ? MONTH
     GROUP BY ym, month
     ORDER BY ym ASC`,
    [months]
  );
  return rows.map((r) => ({ month: r.month, value: r.value }));
}

/** Top companies by live (approved) listing count -- feeds the donut chart. */
async function topCompanies(limit = 3) {
  const [rows] = await pool.query(
    `SELECT c.company_name AS name, COUNT(p.id) AS count
     FROM companies c
     JOIN properties p ON p.company_id = c.id AND p.deleted_at IS NULL AND p.status = 'approved'
     GROUP BY c.id, c.company_name
     ORDER BY count DESC
     LIMIT ${Number(limit)}`
  );
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  return rows.map((r) => ({ name: r.name, value: total > 0 ? Math.round((r.count / total) * 100) : 0 }));
}

async function recentlyAddedProperties(limit = 5) {
  const [rows] = await pool.query(
    `SELECT p.id, p.title, p.price, p.currency, p.listing_type, p.status, p.created_at,
            c.company_name, ap.full_name AS lister_name,
            (SELECT file_path FROM property_images pi WHERE pi.property_id = p.id ORDER BY is_primary DESC, sort_order ASC LIMIT 1) AS cover_image
     FROM properties p
     LEFT JOIN companies c ON c.id = p.company_id
     LEFT JOIN agent_profiles ap ON ap.user_id = p.listed_by_user_id
     WHERE p.deleted_at IS NULL
     ORDER BY p.created_at DESC
     LIMIT ${Number(limit)}`
  );
  return rows;
}

module.exports = { counts, platformGrowth, propertiesTrend, topCompanies, recentlyAddedProperties };
