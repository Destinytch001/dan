'use strict';

const express = require('express');
const { Validator } = require('../../utils/validator');
const response = require('../../utils/response');
const { logger } = require('../../utils/logger');
const { requireAuth, requireRole } = require('../../middleware/auth');
const Review = require('../../models/Review');

const router = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

/**
 * Admin review moderation (Joan, Sep 2026: "fix ...
 * http://localhost:5173/admin/reviews"). Admin-only for now — there is
 * no review-submission entrypoint anywhere in the app yet (see
 * Review.js's doc comment), so this whole module is moderation-only:
 * hide/unhide a review, flag it, or delete it outright. No "reply"
 * endpoint — the old static page had a fake Reply modal, but nothing in
 * the product would ever show that reply back to the reviewee, so it
 * would have been dishonest UI.
 */

router.get(
  '/',
  requireAuth,
  requireRole('admin'),
  wrap(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = Math.min(100, Math.max(1, parseInt(req.query.per_page, 10) || 20));
    const status = ['visible', 'hidden', 'flagged'].includes(req.query.status) ? req.query.status : undefined;
    const revieweeType = ['agent', 'company', 'property'].includes(req.query.reviewee_type)
      ? req.query.reviewee_type
      : undefined;
    const result = await Review.list({ status, reviewee_type: revieweeType, page, perPage });
    return response.success(res, result);
  })
);

router.post(
  '/:id/status',
  requireAuth,
  requireRole('admin'),
  wrap(async (req, res) => {
    const v = new Validator(req.body);
    v.required('status').in('status', ['visible', 'hidden', 'flagged']);
    if (v.fails()) return response.validationError(res, v.errors());
    await Review.updateStatus(req.params.id, req.body.status);
    logger.info('Review status changed by admin', { review_id: req.params.id, status: req.body.status, by: req.authUser.sub });
    return response.success(res, null, 'Review status updated.');
  })
);

router.delete(
  '/:id',
  requireAuth,
  requireRole('admin'),
  wrap(async (req, res) => {
    await Review.remove(req.params.id);
    logger.security('Review deleted by admin', { review_id: req.params.id, by: req.authUser.sub });
    return response.success(res, null, 'Review deleted.');
  })
);

module.exports = router;
