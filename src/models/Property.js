'use strict';

const crypto = require('crypto');
const { pool } = require('../config/db');

function slugify(title) {
  const base = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${base}-${crypto.randomBytes(3).toString('hex')}`;
}

async function create(data) {
  const [result] = await pool.execute(
    `INSERT INTO properties
        (uuid, listed_by_user_id, company_id, property_type_id, listing_type, title, slug,
         description, price, currency, bedrooms, bathrooms, size_sqm, address, city, state,
         latitude, longitude, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(),
      data.listed_by_user_id,
      data.company_id || null,
      data.property_type_id,
      data.listing_type,
      data.title,
      data.slug,
      data.description || null,
      data.price,
      data.currency || 'NGN',
      data.bedrooms ?? null,
      data.bathrooms ?? null,
      data.size_sqm ?? null,
      data.address,
      data.city,
      data.state,
      data.latitude ?? null,
      data.longitude ?? null,
      data.status || 'pending',
    ]
  );
  return result.insertId;
}

async function findById(id) {
  const [rows] = await pool.execute(
    `SELECT p.*, pt.name AS property_type_name, c.company_name, c.user_id AS company_user_id,
            c.verification_status AS company_verification_status, ap.full_name AS realtor_name,
            ap2.full_name AS lister_name, ap2.avatar_path AS lister_avatar_path,
            u.phone AS lister_phone
     FROM properties p
     JOIN property_types pt ON pt.id = p.property_type_id
     LEFT JOIN companies c ON c.id = p.company_id
     LEFT JOIN agent_profiles ap ON ap.user_id = p.listed_by_user_id AND p.company_id IS NULL
     LEFT JOIN agent_profiles ap2 ON ap2.user_id = p.listed_by_user_id
     LEFT JOIN users u ON u.id = p.listed_by_user_id
     WHERE p.id = ? AND p.deleted_at IS NULL LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

/** Public search/browse — only ever returns approved, non-deleted listings. */
async function searchApproved(filters, page, perPage) {
  const where = ["p.status = 'approved'", 'p.deleted_at IS NULL'];
  const params = [];

  if (filters.listing_type) {
    where.push('p.listing_type = ?');
    params.push(filters.listing_type);
  }
  if (filters.city) {
    where.push('p.city = ?');
    params.push(filters.city);
  }
  if (filters.state) {
    where.push('p.state = ?');
    params.push(filters.state);
  }
  if (filters.property_type_id) {
    where.push('p.property_type_id = ?');
    params.push(Number(filters.property_type_id));
  }
  if (filters.company_id) {
    where.push('p.company_id = ?');
    params.push(Number(filters.company_id));
  }
  if (filters.listed_by_user_id) {
    where.push('p.listed_by_user_id = ?');
    params.push(Number(filters.listed_by_user_id));
  }
  if (filters.min_price) {
    where.push('p.price >= ?');
    params.push(Number(filters.min_price));
  }
  if (filters.max_price) {
    where.push('p.price <= ?');
    params.push(Number(filters.max_price));
  }
  if (filters.q) {
    // Plain LIKE across the fields a visitor is actually typing into
    // "Enter Location" / the property-type box, not MySQL FULLTEXT
    // NATURAL LANGUAGE MODE. Two reasons: (1) InnoDB FULLTEXT applies a
    // 50%-of-rows "stopword" rule and a 3-character minimum token size
    // -- on a small/dev dataset (a handful of seeded listings) almost
    // any real search term matches over half the table and gets
    // silently treated as a stopword, so results come back empty even
    // though matching rows exist ("when searching... it doesn't show",
    // Joan, Sep 2026). (2) it only matches whole dictionary words, not
    // the partial/substring text a location search box realistically
    // gets ("3 bed", a partial street name). LIKE with wildcards is the
    // right tool here, not a workaround.
    where.push('(p.title LIKE ? OR p.description LIKE ? OR p.address LIKE ? OR p.city LIKE ? OR p.state LIKE ?)');
    const likeTerm = `%${filters.q}%`;
    params.push(likeTerm, likeTerm, likeTerm, likeTerm, likeTerm);
  }

  const whereSql = where.join(' AND ');

  const [countRows] = await pool.execute(`SELECT COUNT(*) AS total FROM properties p WHERE ${whereSql}`, params);
  const total = countRows[0].total;

  const offset = Math.max(0, (page - 1) * perPage);
  // LIMIT/OFFSET can't be bound as regular placeholders in mysql2's
  // prepared-statement mode reliably across versions, but they ARE
  // safe to inline here because they're `parseInt`-derived integers,
  // never raw request strings — never do this with actual user text.
  const [rows] = await pool.query(
    `SELECT p.id, p.uuid, p.title, p.slug, p.listing_type, p.price, p.currency, p.bedrooms,
            p.bathrooms, p.size_sqm, p.city, p.state, p.views_count, p.created_at,
            pt.name AS property_type_name, c.verification_status AS company_verification_status,
            (SELECT file_path FROM property_images pi WHERE pi.property_id = p.id ORDER BY is_primary DESC, sort_order ASC LIMIT 1) AS cover_image
     FROM properties p
     JOIN property_types pt ON pt.id = p.property_type_id
     LEFT JOIN companies c ON c.id = p.company_id
     WHERE ${whereSql}
     ORDER BY p.created_at DESC
     LIMIT ${Number(perPage)} OFFSET ${Number(offset)}`,
    params
  );

  return { items: rows, total, page, per_page: perPage };
}

// companyId is optional — when the caller is a company account (or an
// agent currently attached to one), this also returns properties listed
// by teammates under that same company_id, not just the caller's own
// listed_by_user_id. A plain agent with no company passes companyId as
// null and gets exactly the old caller-only behavior.
async function findByListerId(userId, status, companyId = null) {
  let sql = `SELECT p.*, pt.name AS property_type_name, ap.full_name AS lister_name,
                    c.verification_status AS company_verification_status,
                    (SELECT file_path FROM property_images pi WHERE pi.property_id = p.id ORDER BY is_primary DESC, sort_order ASC LIMIT 1) AS cover_image
             FROM properties p
             JOIN property_types pt ON pt.id = p.property_type_id
             LEFT JOIN agent_profiles ap ON ap.user_id = p.listed_by_user_id
             LEFT JOIN companies c ON c.id = p.company_id
             WHERE p.deleted_at IS NULL AND (p.listed_by_user_id = ?`;
  const params = [userId];
  if (companyId) {
    sql += ' OR p.company_id = ?';
    params.push(companyId);
  }
  sql += ')';
  if (status) {
    sql += ' AND p.status = ?';
    params.push(status);
  }
  sql += ' ORDER BY p.created_at DESC';

  const [rows] = await pool.execute(sql, params);
  return rows;
}

async function findPending(page, perPage) {
  const [countRows] = await pool.execute(
    "SELECT COUNT(*) AS total FROM properties WHERE status = 'pending' AND deleted_at IS NULL"
  );
  const total = countRows[0].total;

  const offset = Math.max(0, (page - 1) * perPage);
  const [rows] = await pool.query(
    `SELECT p.*, pt.name AS property_type_name, u.email AS lister_email
     FROM properties p
     JOIN property_types pt ON pt.id = p.property_type_id
     JOIN users u ON u.id = p.listed_by_user_id
     WHERE p.status = 'pending' AND p.deleted_at IS NULL
     ORDER BY p.created_at ASC
     LIMIT ${Number(perPage)} OFFSET ${Number(offset)}`
  );

  return { items: rows, total, page, per_page: perPage };
}

async function updateFields(id, fields) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const setSql = keys.map((k) => `${k} = ?`).join(', ');
  const params = [...keys.map((k) => fields[k]), id];
  await pool.execute(`UPDATE properties SET ${setSql} WHERE id = ?`, params);
}

async function approve(id, adminUserId) {
  await pool.execute(
    "UPDATE properties SET status = 'approved', approved_by = ?, approved_at = NOW(), rejection_reason = NULL WHERE id = ?",
    [adminUserId, id]
  );
}

/**
 * findPendingCompanyReview / companyApprove / companyReject: the
 * company-side review queue for listings its own roster agents
 * submit (Joan, Sep 2026 -- "the company must approve/vet the listing
 * before it shows for anyone to see"). Scoped to one company_id so a
 * company only ever sees its own roster's submissions, never another
 * company's.
 *
 * Correction, same session: "its the company that vets and approves
 * properties. The admin only vets and approves companies." Company
 * approval below PUBLISHES the listing directly -- it does not hand
 * it on to a further admin review stage. `findPending`/`approve`/
 * `reject` further down this file implemented that old admin-review
 * stage; they're kept only because nothing currently calls them --
 * the admin routes that used to call them were removed.
 */
async function findPendingCompanyReview(companyId, page, perPage) {
  const [countRows] = await pool.execute(
    "SELECT COUNT(*) AS total FROM properties WHERE status = 'pending_company_review' AND company_id = ? AND deleted_at IS NULL",
    [companyId]
  );
  const total = countRows[0].total;

  const offset = Math.max(0, (page - 1) * perPage);
  const [rows] = await pool.query(
    `SELECT p.*, pt.name AS property_type_name, ap.full_name AS lister_name
     FROM properties p
     JOIN property_types pt ON pt.id = p.property_type_id
     LEFT JOIN agent_profiles ap ON ap.user_id = p.listed_by_user_id
     WHERE p.status = 'pending_company_review' AND p.company_id = ? AND p.deleted_at IS NULL
     ORDER BY p.created_at ASC
     LIMIT ${Number(perPage)} OFFSET ${Number(offset)}`,
    [companyId]
  );

  return { items: rows, total, page, per_page: perPage };
}

async function companyApprove(id, companyUserId) {
  await pool.execute(
    "UPDATE properties SET status = 'approved', approved_by = ?, approved_at = NOW(), rejection_reason = NULL WHERE id = ?",
    [companyUserId, id]
  );
}

async function companyReject(id, companyUserId, reason) {
  await pool.execute(
    "UPDATE properties SET status = 'rejected', approved_by = ?, approved_at = NOW(), rejection_reason = ? WHERE id = ?",
    [companyUserId, reason, id]
  );
}

async function reject(id, adminUserId, reason) {
  await pool.execute(
    "UPDATE properties SET status = 'rejected', approved_by = ?, approved_at = NOW(), rejection_reason = ? WHERE id = ?",
    [adminUserId, reason, id]
  );
}

async function softDelete(id) {
  await pool.execute('UPDATE properties SET deleted_at = NOW() WHERE id = ?', [id]);
}

/** Flips a listing to 'sold' once a property_purchases row completes. */
async function markSold(id) {
  await pool.execute("UPDATE properties SET status = 'sold' WHERE id = ?", [id]);
}

/** Flips a listing to 'rented' once a property_rentals row activates. */
async function markRented(id) {
  await pool.execute("UPDATE properties SET status = 'rented' WHERE id = ?", [id]);
}

async function incrementViews(id) {
  await pool.execute('UPDATE properties SET views_count = views_count + 1 WHERE id = ?', [id]);
}

/**
 * Admin property moderation (Joan, Sep 2026: "admin also can manage
 * properties, flag a property if theres an issue, block a property in
 * which the company will/must appeal"). Flag is soft -- it leaves
 * status untouched, so a flagged-but-approved listing stays visible to
 * the public while the company sorts out whatever admin raised. Block
 * is hard -- it moves status to 'blocked', which searchApproved's
 * `status = 'approved'` filter already excludes on its own, so a
 * blocked listing drops out of every public-facing query with no
 * separate delisting step needed.
 */
async function flag(id, adminUserId, reason) {
  await pool.execute(
    'UPDATE properties SET flagged_at = NOW(), flag_reason = ?, flagged_by = ? WHERE id = ?',
    [reason, adminUserId, id]
  );
}

async function unflag(id) {
  await pool.execute(
    'UPDATE properties SET flagged_at = NULL, flag_reason = NULL, flagged_by = NULL WHERE id = ?',
    [id]
  );
}

async function block(id, adminUserId, reason) {
  await pool.execute(
    "UPDATE properties SET status = 'blocked', blocked_at = NOW(), blocked_reason = ?, blocked_by = ? WHERE id = ?",
    [reason, adminUserId, id]
  );
}

/** Only ever called from PropertyAppeal.resolve('approved') -- a block never lifts without an appeal on record. */
async function unblock(id) {
  await pool.execute(
    "UPDATE properties SET status = 'approved', blocked_at = NULL, blocked_reason = NULL, blocked_by = NULL WHERE id = ?",
    [id]
  );
}

/**
 * Full admin property console -- every status, not just 'pending' like
 * findPending. Optional status/q filters; q does a plain LIKE against
 * title (not the FULLTEXT index searchApproved uses) since admin needs
 * to find newly created or draft listings too, which FULLTEXT's
 * approved-only tuning isn't meant for.
 */
async function findAllForAdmin(filters, page, perPage) {
  const where = ['p.deleted_at IS NULL'];
  const params = [];

  if (filters.status) {
    where.push('p.status = ?');
    params.push(filters.status);
  }
  if (filters.flagged === '1') {
    where.push('p.flagged_at IS NOT NULL');
  }
  if (filters.q) {
    where.push('p.title LIKE ?');
    params.push(`%${filters.q}%`);
  }

  const whereSql = where.join(' AND ');

  const [countRows] = await pool.execute(`SELECT COUNT(*) AS total FROM properties p WHERE ${whereSql}`, params);
  const total = countRows[0].total;

  const offset = Math.max(0, (page - 1) * perPage);
  const [rows] = await pool.query(
    `SELECT p.id, p.uuid, p.title, p.listing_type, p.status, p.price, p.currency,
            p.flagged_at, p.flag_reason, p.blocked_at, p.blocked_reason, p.rejection_reason,
            p.created_at, pt.name AS property_type_name,
            c.company_name, ap.full_name AS lister_name,
            (SELECT file_path FROM property_images pi WHERE pi.property_id = p.id ORDER BY is_primary DESC, sort_order ASC LIMIT 1) AS cover_image
     FROM properties p
     JOIN property_types pt ON pt.id = p.property_type_id
     LEFT JOIN companies c ON c.id = p.company_id
     LEFT JOIN agent_profiles ap ON ap.user_id = p.listed_by_user_id
     WHERE ${whereSql}
     ORDER BY p.created_at DESC
     LIMIT ${Number(perPage)} OFFSET ${Number(offset)}`,
    params
  );

  return { items: rows, total, page, per_page: perPage };
}

module.exports = {
  slugify,
  create,
  findById,
  searchApproved,
  findByListerId,
  findPending,
  findPendingCompanyReview,
  findAllForAdmin,
  updateFields,
  approve,
  reject,
  companyApprove,
  companyReject,
  flag,
  unflag,
  block,
  unblock,
  softDelete,
  incrementViews,
  markSold,
  markRented,
};
