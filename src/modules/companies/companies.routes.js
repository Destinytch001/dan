'use strict';

const express = require('express');
const response = require('../../utils/response');
const Company = require('../../models/Company');
const AgentProfile = require('../../models/AgentProfile');

const router = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

/**
 * Public directory: the main website's "companies & agents" surface
 * (Joan, Sep 2026 -- "the main website is meant to have property
 * listings from the various companies also show the agents"). Every
 * route here is unauthenticated and read-only, mirroring GET
 * /properties's own public/approved-only shape: unverified companies
 * and their agents are still listed (never hidden -- the same
 * "Unverified" badge pattern already shipped on property cards), just
 * flagged, so the directory is honest rather than gatekept.
 *
 * Mounted at /companies in server.js. The flat cross-company agent
 * directory lives in ../agents/agents.routes.js, mounted at /agents.
 */

/** GET /companies (public) -- verified first, then newest; paginated. */
router.get(
  '/',
  wrap(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = Math.min(50, Math.max(1, parseInt(req.query.per_page, 10) || 12));
    const result = await Company.listPublic({ page, perPage, q: req.query.q });
    return response.success(res, result);
  })
);

/** GET /companies/:id (public) -- single company profile + counts. */
router.get(
  '/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const company = await Company.findPublicById(id);
    if (!company) {
      return response.notFound(res, 'Company not found.');
    }
    return response.success(res, company);
  })
);

/** GET /companies/:id/agents (public) -- that company's current roster. */
router.get(
  '/:id/agents',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const company = await Company.findPublicById(id);
    if (!company) {
      return response.notFound(res, 'Company not found.');
    }
    const agents = await AgentProfile.listPublicForCompany(id);
    return response.success(res, agents);
  })
);

module.exports = router;
