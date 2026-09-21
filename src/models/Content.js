'use strict';

const { pool } = require('../config/db');

/**
 * Backs the CMS-ish content that otherwise tends to get hardcoded into
 * React components: static pages (Privacy Policy, Anti-Discrimination),
 * the Help Center's FAQ topics, homepage testimonials, and the blog.
 * Everything here is admin-editable and DB-driven — no copy baked into
 * the frontend build.
 */

// ---- Static pages (Privacy Policy, Anti-Discrimination, etc.) ----

async function getStaticPage(slug) {
  const [rows] = await pool.execute('SELECT * FROM static_pages WHERE slug = ? LIMIT 1', [slug]);
  return rows[0] || null;
}

async function upsertStaticPage(slug, title, contentHtml) {
  await pool.execute(
    `INSERT INTO static_pages (slug, title, content_html) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE title = VALUES(title), content_html = VALUES(content_html)`,
    [slug, title, contentHtml]
  );
}

// Admin list view -- every static page, for the Site Content manager
// (there's no public equivalent since visitors always ask for one
// page by slug via getStaticPage above).
async function listStaticPages() {
  const [rows] = await pool.execute('SELECT * FROM static_pages ORDER BY slug ASC');
  return rows;
}

// ---- Help Center topics (FAQ) ----

async function listHelpTopics(category) {
  let sql = 'SELECT * FROM help_topics WHERE is_active = 1';
  const params = [];
  if (category) {
    sql += ' AND category = ?';
    params.push(category);
  }
  sql += ' ORDER BY sort_order ASC, id ASC';
  const [rows] = await pool.execute(sql, params);
  return rows;
}

async function createHelpTopic({ category, question, answer, sort_order = 0 }) {
  const [result] = await pool.execute(
    'INSERT INTO help_topics (category, question, answer, sort_order) VALUES (?, ?, ?, ?)',
    [category, question, answer, sort_order]
  );
  return result.insertId;
}

async function updateHelpTopic(id, fields) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const setSql = keys.map((k) => `${k} = ?`).join(', ');
  await pool.execute(`UPDATE help_topics SET ${setSql} WHERE id = ?`, [...keys.map((k) => fields[k]), id]);
}

async function deleteHelpTopic(id) {
  await pool.execute('DELETE FROM help_topics WHERE id = ?', [id]);
}

// ---- Testimonials ----

async function listTestimonials(featuredOnly) {
  let sql = 'SELECT * FROM testimonials';
  if (featuredOnly) sql += ' WHERE is_featured = 1';
  sql += ' ORDER BY created_at DESC';
  const [rows] = await pool.execute(sql);
  return rows;
}

async function createTestimonial({ name, role, avatar_path, rating, quote, is_featured }) {
  const [result] = await pool.execute(
    'INSERT INTO testimonials (name, role, avatar_path, rating, quote, is_featured) VALUES (?, ?, ?, ?, ?, ?)',
    [name, role || null, avatar_path || null, rating || 5, quote, is_featured ? 1 : 0]
  );
  return result.insertId;
}

async function deleteTestimonial(id) {
  await pool.execute('DELETE FROM testimonials WHERE id = ?', [id]);
}

// ---- Blog ----

async function listPublishedPosts(page, perPage) {
  const [countRows] = await pool.execute("SELECT COUNT(*) AS total FROM blog_posts WHERE status = 'published'");
  const total = countRows[0].total;
  const offset = Math.max(0, (page - 1) * perPage);
  const [rows] = await pool.query(
    `SELECT id, title, slug, excerpt, cover_image_path, published_at
     FROM blog_posts WHERE status = 'published'
     ORDER BY published_at DESC
     LIMIT ${Number(perPage)} OFFSET ${Number(offset)}`
  );
  return { items: rows, total, page, per_page: perPage };
}

async function getPublishedPostBySlug(slug) {
  const [rows] = await pool.execute("SELECT * FROM blog_posts WHERE slug = ? AND status = 'published' LIMIT 1", [
    slug,
  ]);
  return rows[0] || null;
}

// ---- Blog: admin management (any status, not just published) ----

async function listAllPosts(page, perPage, status) {
  const where = [];
  const params = [];
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [countRows] = await pool.execute(`SELECT COUNT(*) AS total FROM blog_posts ${whereSql}`, params);
  const total = countRows[0].total;
  const offset = Math.max(0, (page - 1) * perPage);
  const [rows] = await pool.query(
    `SELECT id, title, slug, excerpt, cover_image_path, status, published_at, created_at, updated_at
     FROM blog_posts ${whereSql}
     ORDER BY created_at DESC
     LIMIT ${Number(perPage)} OFFSET ${Number(offset)}`,
    params
  );
  return { items: rows, total, page, per_page: perPage };
}

async function getPostById(id) {
  const [rows] = await pool.execute('SELECT * FROM blog_posts WHERE id = ? LIMIT 1', [id]);
  return rows[0] || null;
}

async function deletePost(id) {
  await pool.execute('DELETE FROM blog_posts WHERE id = ?', [id]);
}

async function createPost({ author_id, title, slug, excerpt, content_html, cover_image_path, status }) {
  const publishedAt = status === 'published' ? new Date() : null;
  const [result] = await pool.execute(
    `INSERT INTO blog_posts (author_id, title, slug, excerpt, content_html, cover_image_path, status, published_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [author_id, title, slug, excerpt || null, content_html, cover_image_path || null, status || 'draft', publishedAt]
  );
  return result.insertId;
}

async function updatePost(id, fields) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  if (fields.status === 'published') {
    fields.published_at = new Date();
  }
  const updatedKeys = Object.keys(fields);
  const setSql = updatedKeys.map((k) => `${k} = ?`).join(', ');
  await pool.execute(`UPDATE blog_posts SET ${setSql} WHERE id = ?`, [...updatedKeys.map((k) => fields[k]), id]);
}

module.exports = {
  getStaticPage,
  upsertStaticPage,
  listStaticPages,
  listHelpTopics,
  createHelpTopic,
  updateHelpTopic,
  deleteHelpTopic,
  listTestimonials,
  createTestimonial,
  deleteTestimonial,
  listPublishedPosts,
  getPublishedPostBySlug,
  listAllPosts,
  getPostById,
  deletePost,
  createPost,
  updatePost,
};
