'use strict';

const express = require('express');
const { Validator } = require('../../utils/validator');
const response = require('../../utils/response');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { enforce } = require('../../utils/rateLimiter');
const { logger } = require('../../utils/logger');
const NewsletterSubscriber = require('../../models/NewsletterSubscriber');
const ContactMessage = require('../../models/ContactMessage');

const router = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

/**
 * Public, unauthenticated landing-page forms (Joan, Sep 2026 -- "the
 * forms in the landing page are not working"). Both the homepage's
 * newsletter signup and its "Say Hello to HouseBank" contact form used
 * to only call console.log() on the frontend -- no backend endpoint
 * existed for either, so nothing a visitor submitted ever went anywhere,
 * with no error and no confirmation either. These two routes are real,
 * DB-backed, and -- because they're reachable by anyone with no login,
 * "let security be priority" applies just as much here as to any
 * authenticated endpoint:
 *   - per-IP rate limited (a public form with no rate limit is a free
 *     mail-bomb/spam vector)
 *   - server-side validated (never trust what a public form posts)
 *   - a honeypot field ("company_website") -- a real visitor never sees
 *     or fills it (hidden via CSS on the frontend), so anything that
 *     does is almost certainly a bot. Rather than reject it outright
 *     (which teaches the bot its request shape is wrong), the request
 *     is silently accepted without being written to the database --
 *     indistinguishable from success to the bot, zero junk rows for
 *     Joan.
 */

router.post(
  '/newsletter',
  enforce((req) => `newsletter:${req.ip}`, 10, 3600, 'Too many attempts from this network. Please try again later.'),
  wrap(async (req, res) => {
    if (req.body.company_website) {
      // Honeypot tripped -- pretend success, write nothing.
      return response.success(res, null, 'Subscribed.');
    }

    const v = new Validator(req.body);
    v.required('email', 'Email').email('email').max('email', 191);
    if (v.fails()) return response.validationError(res, v.errors());

    await NewsletterSubscriber.subscribe(String(req.body.email).trim().toLowerCase());
    return response.success(res, null, 'Subscribed.');
  })
);

router.post(
  '/contact',
  enforce((req) => `contact:${req.ip}`, 10, 3600, 'Too many messages from this network. Please try again later.'),
  wrap(async (req, res) => {
    if (req.body.company_website) {
      return response.success(res, null, 'Message sent.');
    }

    const v = new Validator(req.body);
    v.required('full_name', 'Full name').max('full_name', 150);
    v.required('email', 'Email').email('email').max('email', 191);
    v.required('message', 'Message').min('message', 5).max('message', 2000);
    if (v.fails()) return response.validationError(res, v.errors());

    await ContactMessage.create({
      full_name: String(req.body.full_name).trim(),
      email: String(req.body.email).trim().toLowerCase(),
      message: String(req.body.message).trim(),
      ip_address: req.ip,
    });

    logger.info('Landing-page contact message received', { email: req.body.email });
    return response.success(res, null, 'Message sent.');
  })
);

// -------------------------------------------------------------
// Admin: these are real submissions from real visitors -- without a
// read path they'd land in the database and never be seen by anyone.
// No dedicated admin screen exists yet (the admin dashboard's body
// content is still unaudited -- see the project doc), but the data
// itself is real and reachable now rather than a black hole.
// -------------------------------------------------------------

router.get(
  '/newsletter',
  requireAuth,
  requireRole('admin'),
  wrap(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = Math.min(100, Math.max(1, parseInt(req.query.per_page, 10) || 50));
    const result = await NewsletterSubscriber.list(page, perPage);
    return response.success(res, result);
  })
);

router.get(
  '/contact',
  requireAuth,
  requireRole('admin'),
  wrap(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = Math.min(100, Math.max(1, parseInt(req.query.per_page, 10) || 30));
    const status = ['new', 'read'].includes(req.query.status) ? req.query.status : undefined;
    const result = await ContactMessage.list(page, perPage, status);
    return response.success(res, result);
  })
);

router.post(
  '/contact/:id/read',
  requireAuth,
  requireRole('admin'),
  wrap(async (req, res) => {
    await ContactMessage.markRead(req.params.id);
    return response.success(res, null, 'Marked read.');
  })
);

module.exports = router;
