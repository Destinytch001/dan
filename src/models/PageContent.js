'use strict';

const { pool } = require('../config/db');

/**
 * Generic, admin-editable content blocks for the marketing/landing pages
 * (About, Services, Realtor landing, Property Management landing, and
 * the two homepage sections) that used to be 100% hardcoded JSX. See
 * migration 015_page_content.sql for the schema and the seed data that
 * reproduces the exact pre-existing copy.
 *
 * Every row belongs to a `page` (e.g. "about") and a `section` within
 * that page (e.g. "about-team"). A section that has its own heading
 * text stores that heading as a row with extra.kind === "header" at
 * sort_order 0; every other row in the section is a real content item
 * (a card, a step, a team member, ...). The `extra` JSON column is a
 * deliberate escape hatch for whatever a given section needs beyond the
 * common title/subtitle/description/icon/image_path shape (bullet
 * lists, stat blocks, social links, layout hints, etc.) rather than
 * adding a new column for every one-off need.
 */

async function listByPage(page) {
  const [rows] = await pool.execute(
    `SELECT * FROM page_content_items WHERE page = ? AND is_active = 1 ORDER BY section ASC, sort_order ASC, id ASC`,
    [page]
  );
  return rows;
}

// Admin view: every row for a page, including inactive ones, so the
// manager can re-activate something it previously hid.
async function listByPageForAdmin(page) {
  const [rows] = await pool.execute(
    `SELECT * FROM page_content_items WHERE page = ? ORDER BY section ASC, sort_order ASC, id ASC`,
    [page]
  );
  return rows;
}

// Distinct (page, section) pairs, for the admin manager's page/section pickers.
async function listPagesAndSections() {
  const [rows] = await pool.execute(
    `SELECT page, section, COUNT(*) AS item_count
     FROM page_content_items
     GROUP BY page, section
     ORDER BY page ASC, MIN(sort_order) ASC`
  );
  return rows;
}

async function getById(id) {
  const [rows] = await pool.execute('SELECT * FROM page_content_items WHERE id = ? LIMIT 1', [id]);
  return rows[0] || null;
}

async function create({
  page,
  section,
  sort_order = 0,
  icon = null,
  image_path = null,
  title = null,
  subtitle = null,
  description = null,
  extra = null,
  is_active = true,
}) {
  const [result] = await pool.execute(
    `INSERT INTO page_content_items
       (page, section, sort_order, icon, image_path, title, subtitle, description, extra, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      page,
      section,
      sort_order,
      icon,
      image_path,
      title,
      subtitle,
      description,
      extra ? JSON.stringify(extra) : null,
      is_active ? 1 : 0,
    ]
  );
  return result.insertId;
}

// Whitelisted partial update — only the fields the admin editor actually sends.
async function update(id, fields) {
  const allowed = ['section', 'sort_order', 'icon', 'image_path', 'title', 'subtitle', 'description', 'extra', 'is_active'];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (keys.length === 0) return;

  const values = keys.map((k) => {
    if (k === 'extra') return fields.extra ? JSON.stringify(fields.extra) : null;
    if (k === 'is_active') return fields.is_active ? 1 : 0;
    return fields[k];
  });

  const setSql = keys.map((k) => `${k} = ?`).join(', ');
  await pool.execute(`UPDATE page_content_items SET ${setSql} WHERE id = ?`, [...values, id]);
}

async function updateImage(id, imagePath) {
  await pool.execute('UPDATE page_content_items SET image_path = ? WHERE id = ?', [imagePath, id]);
}

async function remove(id) {
  await pool.execute('DELETE FROM page_content_items WHERE id = ?', [id]);
}

module.exports = {
  listByPage,
  listByPageForAdmin,
  listPagesAndSections,
  getById,
  create,
  update,
  updateImage,
  remove,
};
