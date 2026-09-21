'use strict';

const express = require('express');
const { Validator } = require('../../utils/validator');
const response = require('../../utils/response');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { upload, storeImage } = require('../../utils/fileUpload');
const Content = require('../../models/Content');
const PageContent = require('../../models/PageContent');

const router = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// -------------------------------------------------------------
// Public reads — this is what makes About/Privacy/Help/Blog pages
// DB-driven instead of hardcoded strings in the React components.
// -------------------------------------------------------------

/**
 * GET /content/page-items?page=about — public. Powers the marketing/
 * landing-page components (About, Services, Realtor landing, Property
 * Management landing, homepage sections) that used to be 100% hardcoded
 * JSX. Only active rows are returned; a section's own heading (if any)
 * comes back as a normal row with extra.kind === "header".
 */
router.get(
  '/page-items',
  wrap(async (req, res) => {
    const page = String(req.query.page || '').trim();
    if (!page) return response.validationError(res, { page: ['page is required.'] });
    const items = await PageContent.listByPage(page);
    return response.success(res, items);
  })
);

/**
 * GET /content/pages (admin only) -- every static page, for the admin
 * Site Content manager's list view. Registered before the public
 * :slug route below so "pages" itself is never swallowed as a slug
 * (the same route-shadowing bug fixed in properties.routes.js earlier
 * this tranche -- Express matches GET routes in registration order).
 */
router.get(
  '/pages',
  requireAuth,
  requireRole('admin'),
  wrap(async (req, res) => {
    const pages = await Content.listStaticPages();
    return response.success(res, pages);
  })
);

/** GET /content/pages/:slug — e.g. privacy-policy, anti-discrimination */
router.get(
  '/pages/:slug',
  wrap(async (req, res) => {
    const page = await Content.getStaticPage(req.params.slug);
    if (!page) return response.notFound(res, 'Page not found.');
    return response.success(res, page);
  })
);

/** GET /content/help-topics?category=... */
router.get(
  '/help-topics',
  wrap(async (req, res) => {
    const topics = await Content.listHelpTopics(req.query.category || null);
    return response.success(res, topics);
  })
);

/** GET /content/testimonials?featured=1 */
router.get(
  '/testimonials',
  wrap(async (req, res) => {
    const testimonials = await Content.listTestimonials(req.query.featured === '1');
    return response.success(res, testimonials);
  })
);

/** GET /content/blog?page=&per_page= */
router.get(
  '/blog',
  wrap(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = Math.min(50, Math.max(1, parseInt(req.query.per_page, 10) || 10));
    const result = await Content.listPublishedPosts(page, perPage);
    return response.success(res, result);
  })
);

/**
 * GET /content/blog/admin (admin only) -- every post regardless of
 * status, for the admin blog manager list view. Registered before the
 * public :slug route below so "admin" is never swallowed as a slug.
 */
router.get(
  '/blog/admin',
  requireAuth,
  requireRole('admin'),
  wrap(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = Math.min(50, Math.max(1, parseInt(req.query.per_page, 10) || 20));
    const status = ['draft', 'published'].includes(req.query.status) ? req.query.status : undefined;
    const result = await Content.listAllPosts(page, perPage, status);
    return response.success(res, result);
  })
);

/** GET /content/blog/admin/:id (admin only) -- one post by id, any status, for the edit form. */
router.get(
  '/blog/admin/:id',
  requireAuth,
  requireRole('admin'),
  wrap(async (req, res) => {
    const post = await Content.getPostById(Number(req.params.id));
    if (!post) return response.notFound(res, 'Post not found.');
    return response.success(res, post);
  })
);

/** GET /content/blog/:slug (public — published only) */
router.get(
  '/blog/:slug',
  wrap(async (req, res) => {
    const post = await Content.getPublishedPostBySlug(req.params.slug);
    if (!post) return response.notFound(res, 'Post not found.');
    return response.success(res, post);
  })
);

// -------------------------------------------------------------
// Admin writes — everything below requires the admin role.
// -------------------------------------------------------------

/** PUT /content/pages/:slug — Body: { title, content_html } */
router.put(
  '/pages/:slug',
  requireAuth,
  requireRole('admin'),
  wrap(async (req, res) => {
    const v = new Validator(req.body);
    v.required('title').max('title', 191);
    v.required('content_html');
    if (v.fails()) return response.validationError(res, v.errors());

    await Content.upsertStaticPage(req.params.slug, req.body.title, req.body.content_html);
    return response.success(res, null, 'Page saved.');
  })
);

/** POST /content/help-topics — Body: { category, question, answer, sort_order? } */
router.post(
  '/help-topics',
  requireAuth,
  requireRole('admin'),
  wrap(async (req, res) => {
    const v = new Validator(req.body);
    v.required('category').max('category', 80);
    v.required('question').max('question', 255);
    v.required('answer');
    if (v.fails()) return response.validationError(res, v.errors());

    const id = await Content.createHelpTopic(req.body);
    return response.created(res, { id }, 'Help topic created.');
  })
);

router.put(
  '/help-topics/:id',
  requireAuth,
  requireRole('admin'),
  wrap(async (req, res) => {
    const allowed = ['category', 'question', 'answer', 'sort_order', 'is_active'];
    const fields = {};
    for (const key of allowed) if (req.body[key] !== undefined) fields[key] = req.body[key];
    await Content.updateHelpTopic(Number(req.params.id), fields);
    return response.success(res, null, 'Help topic updated.');
  })
);

router.delete(
  '/help-topics/:id',
  requireAuth,
  requireRole('admin'),
  wrap(async (req, res) => {
    await Content.deleteHelpTopic(Number(req.params.id));
    return response.success(res, null, 'Help topic deleted.');
  })
);

/** POST /content/testimonials — multipart if avatar attached */
router.post(
  '/testimonials',
  requireAuth,
  requireRole('admin'),
  upload.single('avatar'),
  wrap(async (req, res) => {
    const v = new Validator(req.body);
    v.required('name').max('name', 150);
    v.required('quote');
    if (v.fails()) return response.validationError(res, v.errors());

    let avatarPath = null;
    if (req.file) avatarPath = await storeImage(req.file.buffer, 'avatars');

    const id = await Content.createTestimonial({ ...req.body, avatar_path: avatarPath });
    return response.created(res, { id }, 'Testimonial created.');
  })
);

router.delete(
  '/testimonials/:id',
  requireAuth,
  requireRole('admin'),
  wrap(async (req, res) => {
    await Content.deleteTestimonial(Number(req.params.id));
    return response.success(res, null, 'Testimonial deleted.');
  })
);

/** POST /content/blog — multipart if cover image attached. Body: { title, slug, excerpt?, content_html, status? } */
router.post(
  '/blog',
  requireAuth,
  requireRole('admin'),
  upload.single('cover'),
  wrap(async (req, res) => {
    const v = new Validator(req.body);
    v.required('title').max('title', 191);
    v.required('slug').max('slug', 220).regex('slug', /^[a-z0-9-]+$/, 'Slug must be lowercase letters, numbers, and hyphens only.');
    v.required('content_html');
    v.in('status', ['draft', 'published']);
    if (v.fails()) return response.validationError(res, v.errors());

    let coverPath = null;
    if (req.file) coverPath = await storeImage(req.file.buffer, 'blog');

    const id = await Content.createPost({
      author_id: req.authUser.sub,
      ...req.body,
      cover_image_path: coverPath,
    });
    return response.created(res, { id }, 'Post created.');
  })
);

router.put(
  '/blog/:id',
  requireAuth,
  requireRole('admin'),
  upload.single('cover'),
  wrap(async (req, res) => {
    const allowed = ['title', 'excerpt', 'content_html', 'status'];
    const fields = {};
    for (const key of allowed) if (req.body[key] !== undefined) fields[key] = req.body[key];
    if (req.file) fields.cover_image_path = await storeImage(req.file.buffer, 'blog');
    await Content.updatePost(Number(req.params.id), fields);
    return response.success(res, null, 'Post updated.');
  })
);

/** DELETE /content/blog/:id (admin only) */
router.delete(
  '/blog/:id',
  requireAuth,
  requireRole('admin'),
  wrap(async (req, res) => {
    const post = await Content.getPostById(Number(req.params.id));
    if (!post) return response.notFound(res, 'Post not found.');
    await Content.deletePost(Number(req.params.id));
    return response.success(res, null, 'Post deleted.');
  })
);

// -------------------------------------------------------------
// Page content (About/Services/Realtor/Property-Management/homepage)
// admin management — everything below requires the admin role.
// -------------------------------------------------------------

function parseExtra(raw, v) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch (e) {
    v.addError('extra', 'extra must be valid JSON.');
    return null;
  }
}

/** GET /content/page-items/admin/sections — every (page, section) group, for the manager's picker. */
router.get(
  '/page-items/admin/sections',
  requireAuth,
  requireRole('admin'),
  wrap(async (req, res) => {
    const sections = await PageContent.listPagesAndSections();
    return response.success(res, sections);
  })
);

/** GET /content/page-items/admin?page=about — every row for a page, including inactive ones. */
router.get(
  '/page-items/admin',
  requireAuth,
  requireRole('admin'),
  wrap(async (req, res) => {
    const page = String(req.query.page || '').trim();
    if (!page) return response.validationError(res, { page: ['page is required.'] });
    const items = await PageContent.listByPageForAdmin(page);
    return response.success(res, items);
  })
);

/** POST /content/page-items — multipart if an image is attached. Body: { page, section, sort_order?, icon?, title?, subtitle?, description?, extra? } */
router.post(
  '/page-items',
  requireAuth,
  requireRole('admin'),
  upload.single('image'),
  wrap(async (req, res) => {
    const v = new Validator(req.body);
    v.required('page').max('page', 60);
    v.required('section').max('section', 80);
    if (v.fails()) return response.validationError(res, v.errors());

    const extra = parseExtra(req.body.extra, v);
    if (v.fails()) return response.validationError(res, v.errors());

    let imagePath = null;
    if (req.file) imagePath = await storeImage(req.file.buffer, 'page-content');

    const id = await PageContent.create({
      page: req.body.page,
      section: req.body.section,
      sort_order: req.body.sort_order !== undefined ? Number(req.body.sort_order) : 0,
      icon: req.body.icon || null,
      image_path: imagePath,
      title: req.body.title || null,
      subtitle: req.body.subtitle || null,
      description: req.body.description || null,
      extra,
      is_active: req.body.is_active === undefined ? true : req.body.is_active === '0' || req.body.is_active === false ? false : true,
    });
    return response.created(res, { id }, 'Content item created.');
  })
);

/** PUT /content/page-items/:id — multipart if a new image is attached. Only sends the fields it wants to change. */
router.put(
  '/page-items/:id',
  requireAuth,
  requireRole('admin'),
  upload.single('image'),
  wrap(async (req, res) => {
    const existing = await PageContent.getById(Number(req.params.id));
    if (!existing) return response.notFound(res, 'Content item not found.');

    const v = new Validator(req.body);
    const fields = {};
    const allowed = ['section', 'sort_order', 'icon', 'title', 'subtitle', 'description', 'is_active'];
    for (const key of allowed) {
      if (req.body[key] !== undefined) fields[key] = req.body[key];
    }
    if (fields.sort_order !== undefined) fields.sort_order = Number(fields.sort_order);
    if (fields.is_active !== undefined) fields.is_active = !(fields.is_active === '0' || fields.is_active === false || fields.is_active === 'false');

    if (req.body.extra !== undefined) {
      fields.extra = parseExtra(req.body.extra, v);
      if (v.fails()) return response.validationError(res, v.errors());
    }

    if (req.file) fields.image_path = await storeImage(req.file.buffer, 'page-content');

    await PageContent.update(Number(req.params.id), fields);
    return response.success(res, null, 'Content item updated.');
  })
);

/** DELETE /content/page-items/:id (admin only) */
router.delete(
  '/page-items/:id',
  requireAuth,
  requireRole('admin'),
  wrap(async (req, res) => {
    const existing = await PageContent.getById(Number(req.params.id));
    if (!existing) return response.notFound(res, 'Content item not found.');
    await PageContent.remove(Number(req.params.id));
    return response.success(res, null, 'Content item deleted.');
  })
);

module.exports = router;
