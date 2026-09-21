'use strict';

const express = require('express');
const { Validator } = require('../../utils/validator');
const response = require('../../utils/response');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { enforce } = require('../../utils/rateLimiter');
const { logger } = require('../../utils/logger');
const IncidentReport = require('../../models/IncidentReport');
const Company = require('../../models/Company');
const { resolveCallerCompanyId } = require('../../utils/companyScope');

const router = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

/**
 * Two public, unauthenticated report forms (Joan, Sep 2026: "the form in
 * /report-concern is not working or submitting to the company. this
 * /report-scam is not submitting to the overall admin"). Neither had a
 * backend endpoint at all -- both only called console.log(). Real, rate-
 * limited, validated, honeypot-protected, same posture as the leads
 * module (newsletter/contact).
 */

router.post(
  '/concern',
  enforce((req) => `report-concern:${req.ip}`, 10, 3600, 'Too many reports from this network. Please try again later.'),
  wrap(async (req, res) => {
    if (req.body.company_website) {
      return response.success(res, null, 'Report submitted.');
    }

    const v = new Validator(req.body);
    v.required('description', 'Description').min('description', 10).max('description', 4000);
    if (req.body.reporter_email) v.email('reporter_email');
    if (req.body.company_id !== undefined && req.body.company_id !== '') v.integer('company_id');
    if (v.fails()) return response.validationError(res, v.errors());

    let companyId = null;
    if (req.body.company_id) {
      const company = await Company.findById(Number(req.body.company_id));
      if (!company) return response.validationError(res, { company_id: ['Company not found.'] });
      companyId = company.id;
    }

    await IncidentReport.create({
      type: 'neighbourhood_concern',
      company_id: companyId,
      reporter_full_name: req.body.reporter_full_name || null,
      reporter_email: req.body.reporter_email || null,
      reporter_phone: req.body.reporter_phone || null,
      incident_date: req.body.incident_date || null,
      description: String(req.body.description).trim(),
      ip_address: req.ip,
    });

    logger.info('Neighbourhood concern report received', { company_id: companyId });
    return response.success(res, null, 'Report submitted.');
  })
);

router.post(
  '/scam',
  enforce((req) => `report-scam:${req.ip}`, 10, 3600, 'Too many reports from this network. Please try again later.'),
  wrap(async (req, res) => {
    if (req.body.company_website) {
      return response.success(res, null, 'Report submitted.');
    }

    const v = new Validator(req.body);
    v.required('description', 'Description').min('description', 10).max('description', 4000);
    if (req.body.reporter_email) v.email('reporter_email');
    if (req.body.scammer_email) v.email('scammer_email');
    if (v.fails()) return response.validationError(res, v.errors());

    const moneyLost = req.body.money_lost === 'yes' ? true : req.body.money_lost === 'no' ? false : null;

    await IncidentReport.create({
      type: 'scam',
      reporter_full_name: req.body.reporter_full_name || null,
      reporter_email: req.body.reporter_email || null,
      reporter_phone: req.body.reporter_phone || null,
      incident_date: req.body.incident_date || null,
      description: String(req.body.description).trim(),
      scammer_name: req.body.scammer_name || null,
      scammer_email: req.body.scammer_email || null,
      scammer_phone: req.body.scammer_phone || null,
      money_lost: moneyLost,
      amount_lost: moneyLost && req.body.amount_lost ? Number(req.body.amount_lost) || null : null,
      ip_address: req.ip,
    });

    logger.security('Scam report received', { has_scammer_info: Boolean(req.body.scammer_name || req.body.scammer_email) });
    return response.success(res, null, 'Report submitted.');
  })
);

// -------------------------------------------------------------
// Visibility: admin sees everything; a company can see concern
// reports filed about itself. No dedicated screen exists yet for
// either (same gap as the leads module) -- these make the real
// submissions reachable rather than a black hole.
// -------------------------------------------------------------

router.get(
  '/mine',
  requireAuth,
  requireRole('company'),
  wrap(async (req, res) => {
    const companyId = await resolveCallerCompanyId(req.authUser);
    if (!companyId) return response.success(res, { items: [], total: 0, page: 1, per_page: 30 });
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = Math.min(100, Math.max(1, parseInt(req.query.per_page, 10) || 30));
    const result = await IncidentReport.listForCompany(companyId, page, perPage);
    return response.success(res, result);
  })
);

router.get(
  '/',
  requireAuth,
  requireRole('admin'),
  wrap(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = Math.min(100, Math.max(1, parseInt(req.query.per_page, 10) || 30));
    const type = ['neighbourhood_concern', 'scam'].includes(req.query.type) ? req.query.type : undefined;
    const status = ['new', 'reviewing', 'resolved'].includes(req.query.status) ? req.query.status : undefined;
    const result = await IncidentReport.list({ type, status, page, perPage });
    return response.success(res, result);
  })
);

router.get(
  '/stats',
  requireAuth,
  requireRole('admin'),
  wrap(async (req, res) => {
    const result = await IncidentReport.stats();
    return response.success(res, result);
  })
);

router.post(
  '/:id/status',
  requireAuth,
  requireRole('admin'),
  wrap(async (req, res) => {
    const v = new Validator(req.body);
    v.required('status').in('status', ['new', 'reviewing', 'resolved']);
    if (v.fails()) return response.validationError(res, v.errors());
    await IncidentReport.updateStatus(req.params.id, req.body.status);
    return response.success(res, null, 'Status updated.');
  })
);

module.exports = router;
