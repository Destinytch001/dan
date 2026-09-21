'use strict';

const express = require('express');
const { withTransaction } = require('../../config/db');
const { Validator } = require('../../utils/validator');
const response = require('../../utils/response');
const { logger } = require('../../utils/logger');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { enforce } = require('../../utils/rateLimiter');
const { resolveCallerCompanyId } = require('../../utils/companyScope');
const Property = require('../../models/Property');
const PropertyRental = require('../../models/PropertyRental');
const Transaction = require('../../models/Transaction');
const Notification = require('../../models/Notification');
const User = require('../../models/User');
const { sendSms } = require('../../utils/sms');

const router = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

/**
 * POST /rentals (admin, or the property's own listing agent/company) —
 * same reasoning as purchases.routes.js: the lease is agreed and
 * processed at the office after a viewing, and staff record it here
 * once the company has approved it. Rent is treated as one upfront
 * payment for the whole lease term (rent_amount * rent_period_months) —
 * see PropertyRental.js for why. No live payment gateway wired up yet.
 */
router.post(
  '/',
  requireAuth,
  requireRole('admin', 'company', 'agent'),
  wrap(async (req, res) => {
    const v = new Validator(req.body);
    v.required('property_id').integer('property_id');
    v.required('tenant_user_id').integer('tenant_user_id');
    v.integer('rent_period_months');
    if (v.fails()) return response.validationError(res, v.errors());
    const data = v.validated();

    const periodMonths = data.rent_period_months ? Number(data.rent_period_months) : 12;
    if (periodMonths < 1 || periodMonths > 60) {
      return response.validationError(res, { rent_period_months: ['Rent period must be between 1 and 60 months.'] });
    }

    const property = await Property.findById(Number(data.property_id));
    if (!property) return response.notFound(res, 'Property not found.');
    if (property.listing_type !== 'rent') {
      return response.validationError(res, { property_id: ['This property is not listed for rent.'] });
    }
    if (property.status !== 'approved') {
      return response.validationError(res, { property_id: ['This property is not currently available.'] });
    }
    if (req.authUser.role !== 'admin' && property.listed_by_user_id !== req.authUser.sub) {
      logger.security('Blocked IDOR attempt on rental creation', {
        property_id: property.id,
        attempted_by: req.authUser.sub,
      });
      return response.forbidden(res, 'You do not have permission to record a lease for this property.');
    }

    const tenant = await User.findById(Number(data.tenant_user_id));
    if (!tenant || tenant.role !== 'customer') {
      return response.validationError(res, { tenant_user_id: ['Must be an existing customer account.'] });
    }

    const totalRent = Number(property.price) * periodMonths;

    const rentalId = await withTransaction(async (conn) => {
      const id = await PropertyRental.create(conn, {
        tenant_user_id: tenant.id,
        property_id: property.id,
        rent_amount: property.price,
        rent_period_months: periodMonths,
      });
      await Transaction.create(conn, {
        user_id: tenant.id,
        type: 'property_rent',
        reference_table: 'property_rentals',
        reference_id: id,
        amount: totalRent,
        payment_method: 'manual_transfer',
      });
      return id;
    });

    await Notification.create(
      tenant.id,
      'property_rent',
      'Rental recorded',
      `Your rental of "${property.title}" has been recorded and is awaiting final confirmation.`
    );

    logger.security('Property rental recorded by staff', {
      rental_id: rentalId,
      tenant_user_id: tenant.id,
      recorded_by: req.authUser.sub,
    });
    return response.created(res, { id: rentalId }, 'Rental recorded.');
  })
);

/** GET /rentals/mine (protected) — the current user's own rentals */
router.get(
  '/mine',
  requireAuth,
  wrap(async (req, res) => {
    const rows = await PropertyRental.forTenant(req.authUser.sub);
    return response.success(res, rows);
  })
);

/**
 * POST /rentals/request (customer) — customer-facing front door onto
 * the same "staff records the lease" flow POST / above powers. Creates
 * a 'requested' row only — no Transaction, nothing agreed yet — which
 * the property's listing agent/company (or admin) then approves or
 * declines below. Same reasoning as purchases.routes.js's POST /request.
 */
router.post(
  '/request',
  requireAuth,
  requireRole('customer'),
  enforce((req) => `rental-request:${req.authUser.sub}`, 10, 3600, 'Too many rental requests. Please wait before trying again.'),
  wrap(async (req, res) => {
    const v = new Validator(req.body);
    v.required('property_id').integer('property_id');
    v.integer('rent_period_months');
    if (v.fails()) return response.validationError(res, v.errors());
    const data = v.validated();

    const periodMonths = data.rent_period_months ? Number(data.rent_period_months) : 12;
    if (periodMonths < 1 || periodMonths > 60) {
      return response.validationError(res, { rent_period_months: ['Rent period must be between 1 and 60 months.'] });
    }

    const property = await Property.findById(Number(data.property_id));
    if (!property) return response.notFound(res, 'Property not found.');
    if (property.listing_type !== 'rent') {
      return response.validationError(res, { property_id: ['This property is not listed for rent.'] });
    }
    if (property.status !== 'approved') {
      return response.validationError(res, { property_id: ['This property is not currently available.'] });
    }

    const alreadyOpen = await PropertyRental.hasOpenRequest(req.authUser.sub, property.id);
    if (alreadyOpen) {
      return response.validationError(res, { property_id: ['You already have an open request for this property.'] });
    }

    const id = await PropertyRental.request(null, {
      tenant_user_id: req.authUser.sub,
      property_id: property.id,
      rent_amount: property.price,
      rent_period_months: periodMonths,
    });

    await Notification.create(
      req.authUser.sub,
      'property_rent',
      'Rental request sent',
      `Your request to rent "${property.title}" has been sent to the listing agent for review.`
    );

    // Same lister-notification gap as viewings/purchases -- see that
    // route's comment. Company account gets it for a company listing
    // (it assigns which realtor follows up), the individual agent
    // otherwise.
    const listerNotifyUserId = property.company_id ? property.company_user_id : property.listed_by_user_id;
    if (listerNotifyUserId) {
      await Notification.create(
        listerNotifyUserId,
        'property_rent',
        'New rental request',
        `A customer has requested to rent "${property.title}".`
      );
    }

    logger.info('Property rental requested', {
      rental_id: id,
      tenant_user_id: req.authUser.sub,
      property_id: property.id,
    });
    return response.created(res, { id }, 'Rental request sent.');
  })
);

/** POST /rentals/:id/cancel (customer) — withdraw your own still-open request */
router.post(
  '/:id/cancel',
  requireAuth,
  requireRole('customer'),
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const ok = await PropertyRental.cancelOwnRequest(id, req.authUser.sub);
    if (!ok) return response.notFound(res, 'Rental request not found or already handled.');
    return response.success(res, null, 'Rental request cancelled.');
  })
);

/**
 * GET /rentals/for-my-listings (agent/company) — every rental against
 * a property this user lists, same purpose as the purchases version.
 */
router.get(
  '/for-my-listings',
  requireAuth,
  requireRole('agent', 'company'),
  wrap(async (req, res) => {
    const companyId = await resolveCallerCompanyId(req.authUser);
    const rows = await PropertyRental.forLister(req.authUser.sub, companyId, req.query.status || null);
    return response.success(res, rows);
  })
);

/**
 * POST /rentals/:id/confirm (admin, or the property's own listing
 * agent/company) — the manual counterpart to a Paystack webhook. Marks
 * the rental active (sets lease start/end dates), the property rented,
 * the matching transaction successful, cancels any other pending
 * intents on the same property, and notifies the tenant.
 */
router.post(
  '/:id/confirm',
  requireAuth,
  requireRole('admin', 'company', 'agent'),
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const rental = await PropertyRental.findById(id);
    if (!rental) return response.notFound(res, 'Rental not found.');
    if (rental.status !== 'pending_payment') {
      return response.validationError(res, { status: ['This rental is not awaiting confirmation.'] });
    }

    const property = await Property.findById(rental.property_id);
    if (req.authUser.role !== 'admin' && property.listed_by_user_id !== req.authUser.sub) {
      logger.security('Blocked IDOR attempt on rental confirmation', {
        rental_id: id,
        attempted_by: req.authUser.sub,
      });
      return response.forbidden(res, 'You do not have permission to confirm this rental.');
    }
    if (property.status === 'rented') {
      return response.validationError(res, { status: ['This property is already rented.'] });
    }

    await withTransaction(async (conn) => {
      await PropertyRental.activate(conn, id, rental.rent_period_months);
      await PropertyRental.cancelOtherPending(conn, rental.property_id, id);
      const txn = await Transaction.findByReference('property_rentals', id, 'property_rent');
      if (txn) await Transaction.markStatus(conn, txn.id, 'success');
    });
    await Property.markRented(rental.property_id);

    await Notification.create(
      rental.tenant_user_id,
      'property_rent',
      'Rental confirmed',
      `Your rental of "${property.title}" has been confirmed.`
    );
    const tenantForSms = await User.findById(rental.tenant_user_id);
    await sendSms(tenantForSms?.phone, `HouseBank: your rental of "${property.title}" has been confirmed.`);

    logger.security('Property rental confirmed', { rental_id: id, confirmed_by: req.authUser.sub });
    return response.success(res, null, 'Rental confirmed.');
  })
);

/**
 * POST /rentals/:id/approve (admin, or the property's own listing
 * agent/company) — approves a customer-submitted request, promoting it
 * to the same 'pending_payment' state POST / creates directly, and only
 * now opens the matching Transaction. Optional `note` is stored and
 * passed back to the tenant in their notification.
 */
router.post(
  '/:id/approve',
  requireAuth,
  requireRole('admin', 'company', 'agent'),
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const rental = await PropertyRental.findById(id);
    if (!rental) return response.notFound(res, 'Rental request not found.');
    if (rental.status !== 'requested') {
      return response.validationError(res, { status: ['This request has already been handled.'] });
    }

    const property = await Property.findById(rental.property_id);
    if (req.authUser.role !== 'admin' && property.listed_by_user_id !== req.authUser.sub) {
      logger.security('Blocked IDOR attempt on rental approval', {
        rental_id: id,
        attempted_by: req.authUser.sub,
      });
      return response.forbidden(res, 'You do not have permission to approve this request.');
    }
    if (property.status !== 'approved') {
      return response.validationError(res, { status: ['This property is no longer available.'] });
    }

    const v = new Validator(req.body);
    v.max('note', 500);
    if (v.fails()) return response.validationError(res, v.errors());
    const note = v.validated().note || null;

    const totalRent = Number(rental.rent_amount) * Number(rental.rent_period_months);

    await withTransaction(async (conn) => {
      await PropertyRental.approve(conn, id, note);
      await Transaction.create(conn, {
        user_id: rental.tenant_user_id,
        type: 'property_rent',
        reference_table: 'property_rentals',
        reference_id: id,
        amount: totalRent,
        payment_method: 'manual_transfer',
      });
    });

    await Notification.create(
      rental.tenant_user_id,
      'property_rent',
      'Rental request approved',
      `Your request to rent "${property.title}" has been approved and recorded. It's now awaiting final confirmation.`
    );

    logger.security('Property rental request approved', { rental_id: id, approved_by: req.authUser.sub });
    return response.success(res, null, 'Rental request approved.');
  })
);

/**
 * POST /rentals/:id/decline (admin, or the property's own listing
 * agent/company) — rejects a customer-submitted request. No property or
 * Transaction side effects; the customer can submit a fresh request.
 */
router.post(
  '/:id/decline',
  requireAuth,
  requireRole('admin', 'company', 'agent'),
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const rental = await PropertyRental.findById(id);
    if (!rental) return response.notFound(res, 'Rental request not found.');
    if (rental.status !== 'requested') {
      return response.validationError(res, { status: ['This request has already been handled.'] });
    }

    const property = await Property.findById(rental.property_id);
    if (req.authUser.role !== 'admin' && property.listed_by_user_id !== req.authUser.sub) {
      logger.security('Blocked IDOR attempt on rental decline', {
        rental_id: id,
        attempted_by: req.authUser.sub,
      });
      return response.forbidden(res, 'You do not have permission to decline this request.');
    }

    const v = new Validator(req.body);
    v.max('note', 500);
    if (v.fails()) return response.validationError(res, v.errors());
    const note = v.validated().note || null;

    await PropertyRental.decline(id, note);

    await Notification.create(
      rental.tenant_user_id,
      'property_rent',
      'Rental request declined',
      note
        ? `Your request to rent "${property.title}" was declined: ${note}`
        : `Your request to rent "${property.title}" was declined.`
    );

    logger.info('Property rental request declined', { rental_id: id, declined_by: req.authUser.sub });
    return response.success(res, null, 'Rental request declined.');
  })
);

module.exports = router;
