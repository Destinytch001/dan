'use strict';

const express = require('express');
const response = require('../../utils/response');
const AgentProfile = require('../../models/AgentProfile');

const router = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

/**
 * Public, flat "Find an Agent" directory across every company -- the
 * counterpart to /companies/:id/agents (one company's roster). Same
 * unauthenticated, unverified-not-hidden shape as the rest of the
 * public surface. See companies.routes.js for the fuller writeup.
 */

/** GET /agents (public) -- searchable, paginated, newest-verified first. */
router.get(
  '/',
  wrap(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = Math.min(50, Math.max(1, parseInt(req.query.per_page, 10) || 12));
    const result = await AgentProfile.listPublic({ page, perPage, q: req.query.q, companyId: req.query.company_id });
    return response.success(res, result);
  })
);

module.exports = router;
