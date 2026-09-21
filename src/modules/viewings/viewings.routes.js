'use strict';

const express = require('express');
const { Validator } = require('../../utils/validator');
const response = require('../../utils/response');
const { logger } = require('../../utils/logger');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { enforce } = require('../../utils/rateLimiter');
const { resolveCallerCompanyId } = require('../../utils/companyScope');
const Property = require('../../models/Property');
const PropertyViewing = require('../../models/PropertyViewing');
const Notification = require('../../models/Notification');
const { sendSms } = require('../../utils/sms');

const router = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/;

/**
 * POST /viewings (protected) — a customer requests to view a property in
 * person with an agent. This, not a "Buy Now" button, is the real start
 * of buying/renting/selling at HouseBank: the transaction itself happens
 * at the office and is entered by staff (see purchases/rentals routes).
 */
router.post(
  '/',
  requireAuth,
  enforce((req) => `viewing-create:${req.authUser.sub}`, 20, 3600, 'Too many viewing requests. Please wait before requesting more.'),
  wrap(async (req, res) => {
    const v = new Validator(req.body);
    v.required('property_id').integer('property_id');
    v.required('preferred_date');
    v.required('full_name').max('full_name', 191);
    v.required('phone').phone('phone');
    v.max('message', 500);
    if (v.fails()) return response.validationError(res, v.errors());
    const data = v.validated();

    if (!DATE_RE.test(String(data.preferred_date))) {
      return response.validationError(res, { preferred_date: ['Must be a valid date (YYYY-MM-DD).'] });
    }
    if (data.preferred_time && !TIME_RE.test(String(data.preferred_time))) {
      return response.validationError(res, { preferred_time: ['Must be a valid time (HH:MM).'] });
    }
    if (new Date(data.preferred_date) < new Date(new Date().toDateString())) {
      return response.validationError(res, { preferred_date: ['Preferred date must be today or later.'] });
    }

    const property = await Property.findById(Number(data.property_id));
    if (!property) return response.notFound(res, 'Property not found.');
    if (property.status !== 'approved') {
      return response.validationError(res, { property_id: ['This property is not currently available.'] });
    }

    const id = await PropertyViewing.create({
      customer_user_id: req.authUser.sub,
      property_id: property.id,
      preferred_date: data.preferred_date,
      preferred_time: data.preferred_time,
      full_name: data.full_name,
      phone: data.phone,
      message: data.message,
    });

    await Notification.create(
      req.authUser.sub,
      'property_viewing',
      'Viewing request received',
      `Your request to view "${property.title}" has been received. An agent will reach out to confirm a time.`
    );

    // Joan, Sep 2026: "the company did not get any notification" -- this
    // was missing entirely. When the property has a company_id, the
    // company account is who's notified (Joan: "its the company that
    // assign a realtor" -- the company triages and assigns which
    // realtor handles each request); otherwise the individual agent who
    // listed it. company_user_id comes from Property.findById's join.
    const listerNotifyUserId = property.company_id ? property.company_user_id : property.listed_by_user_id;
    if (listerNotifyUserId) {
      await Notification.create(
        listerNotifyUserId,
        'property_viewing',
        'New viewing request',
        `${data.full_name} requested to view "${property.title}" on ${data.preferred_date}${data.preferred_time ? ` at ${data.preferred_time}` : ''}.`
      );
    }

    logger.info('Property viewing requested', { viewing_id: id, user_id: req.authUser.sub, property_id: property.id });
    return response.created(res, { id }, 'Viewing request recorded.');
  })
);

/** GET /viewings/mine (protected) — the current user's own viewing requests */
router.get(
  '/mine',
  requireAuth,
  wrap(async (req, res) => {
    const rows = await PropertyViewing.forCustomer(req.authUser.sub);
    return response.success(res, rows);
  })
);

/** POST /viewings/:id/cancel (protected) — a customer cancels their own still-pending request */
router.post(
  '/:id/cancel',
  requireAuth,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const ok = await PropertyViewing.cancel(id, req.authUser.sub);
    if (!ok) return response.notFound(res, 'Viewing request not found or already handled.');
    return response.success(res, null, 'Viewing request cancelled.');
  })
);

/**
 * GET /viewings/for-my-properties (admin, or the property's own
 * listing agent/company) — the missing piece that made confirm/
 * complete above unusable from any real screen: there was no way to
 * even see a pending request without already knowing its ID. Optional
 * ?status= filter (e.g. 'requested') for a "needs your action" view.
 */
router.get(
  '/for-my-properties',
  requireAuth,
  requireRole('admin', 'company', 'agent'),
  wrap(async (req, res) => {
    const companyId = await resolveCallerCompanyId(req.authUser);
    const rows = await PropertyViewing.forLister(req.authUser.sub, req.query.status || null, companyId);
    return response.success(res, rows);
  })
);

/**
 * POST /viewings/:id/confirm (admin, or the property's own listing
 * agent/company) — staff schedules the actual viewing appointment.
 */
router.post(
  '/:id/confirm',
  requireAuth,
  requireRole('admin', 'company', 'agent'),
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const viewing = await PropertyViewing.findById(id);
    if (!viewing) return response.notFound(res, 'Viewing request not found.');
    if (viewing.status !== 'requested') {
      return response.validationError(res, { status: ['This viewing is not awaiting confirmation.'] });
    }

    const property = await Property.findById(viewing.property_id);
    if (req.authUser.role !== 'admin' && property.listed_by_user_id !== req.authUser.sub) {
      logger.security('Blocked IDOR attempt on viewing confirmation', {
        viewing_id: id,
        attempted_by: req.authUser.sub,
      });
      return response.forbidden(res, 'You do not have permission to confirm this viewing.');
    }

    const scheduledAt = req.body.scheduled_at || `${viewing.preferred_date} ${viewing.preferred_time || '10:00:00'}`;
    await PropertyViewing.confirm(id, req.authUser.sub, scheduledAt);

    await Notification.create(
      viewing.customer_user_id,
      'property_viewing',
      'Viewing confirmed',
      `Your viewing of "${property.title}" has been confirmed for ${scheduledAt}.`
    );
    await sendSms(
      viewing.phone,
      `HouseBank: your viewing of "${property.title}" is confirmed for ${scheduledAt}.`
    );

    logger.info('Property viewing confirmed', { viewing_id: id, confirmed_by: req.authUser.sub });
    return response.success(res, null, 'Viewing confirmed.');
  })
);

/** POST /viewings/:id/complete (admin, or the property's own listing agent/company) */
router.post(
  '/:id/complete',
  requireAuth,
  requireRole('admin', 'company', 'agent'),
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const viewing = await PropertyViewing.findById(id);
    if (!viewing) return response.notFound(res, 'Viewing request not found.');
    if (viewing.status !== 'confirmed') {
      return response.validationError(res, { status: ['This viewing is not confirmed yet.'] });
    }

    const property = await Property.findById(viewing.property_id);
    if (req.authUser.role !== 'admin' && property.listed_by_user_id !== req.authUser.sub) {
      logger.security('Blocked IDOR attempt on viewing completion', {
        viewing_id: id,
        attempted_by: req.authUser.sub,
      });
      return response.forbidden(res, 'You do not have permission to update this viewing.');
    }

    await PropertyViewing.complete(id, req.authUser.sub);
    logger.info('Property viewing completed', { viewing_id: id, completed_by: req.authUser.sub });
    return response.success(res, null, 'Viewing marked completed.');
  })
);

module.exports = router;
