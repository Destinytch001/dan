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
const PropertyPurchase = require('../../models/PropertyPurchase');
const Transaction = require('../../models/Transaction');
const Notification = require('../../models/Notification');
const User = require('../../models/User');
const { sendSms } = require('../../utils/sms');

const router = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

/**
 * POST /purchases (admin, or the property's own listing agent/company)
 * — HouseBank doesn't do self-service checkout: a customer books a
 * viewing (see the viewings module), the actual sale is agreed and
 * processed at the office, and staff record it here once the company
 * has approved it. This is what then shows up on the customer's own
 * "My Properties" page. No live payment gateway is wired up yet (see
 * docs/ROADMAP.md); price is frozen from the property's current listed
 * price at the moment this is recorded.
 */
router.post(
  '/',
  requireAuth,
  requireRole('admin', 'company', 'agent'),
  wrap(async (req, res) => {
    const v = new Validator(req.body);
    v.required('property_id').integer('property_id');
    v.required('buyer_user_id').integer('buyer_user_id');
    if (v.fails()) return response.validationError(res, v.errors());
    const data = v.validated();

    const property = await Property.findById(Number(data.property_id));
    if (!property) return response.notFound(res, 'Property not found.');
    if (property.listing_type !== 'sale') {
      return response.validationError(res, { property_id: ['This property is not listed for sale.'] });
    }
    if (property.status !== 'approved') {
      return response.validationError(res, { property_id: ['This property is not currently available.'] });
    }
    if (req.authUser.role !== 'admin' && property.listed_by_user_id !== req.authUser.sub) {
      logger.security('Blocked IDOR attempt on purchase creation', {
        property_id: property.id,
        attempted_by: req.authUser.sub,
      });
      return response.forbidden(res, 'You do not have permission to record a sale for this property.');
    }

    const buyer = await User.findById(Number(data.buyer_user_id));
    if (!buyer || buyer.role !== 'customer') {
      return response.validationError(res, { buyer_user_id: ['Must be an existing customer account.'] });
    }

    const purchaseId = await withTransaction(async (conn) => {
      const id = await PropertyPurchase.create(conn, {
        buyer_user_id: buyer.id,
        property_id: property.id,
        agreed_price: property.price,
      });
      await Transaction.create(conn, {
        user_id: buyer.id,
        type: 'property_purchase',
        reference_table: 'property_purchases',
        reference_id: id,
        amount: property.price,
        payment_method: 'manual_transfer',
      });
      return id;
    });

    await Notification.create(
      buyer.id,
      'property_purchase',
      'Purchase recorded',
      `Your purchase of "${property.title}" has been recorded and is awaiting final confirmation.`
    );

    logger.security('Property purchase recorded by staff', {
      purchase_id: purchaseId,
      buyer_user_id: buyer.id,
      recorded_by: req.authUser.sub,
    });
    return response.created(res, { id: purchaseId }, 'Purchase recorded.');
  })
);

/** GET /purchases/mine (protected) — the current user's own purchases */
router.get(
  '/mine',
  requireAuth,
  wrap(async (req, res) => {
    const rows = await PropertyPurchase.forBuyer(req.authUser.sub);
    return response.success(res, rows);
  })
);

/**
 * POST /purchases/request (customer) — the customer-facing front door
 * onto the same "staff records the sale" flow POST / above powers.
 * Creates a 'requested' row only — no Transaction, nothing agreed yet —
 * which the property's listing agent/company (or admin) then approves
 * or declines below. Same reasoning as property_viewings' POST /:
 * HouseBank doesn't do self-service checkout, but the customer still
 * needs a real, working way to start the process instead of a button
 * that 403's.
 */
router.post(
  '/request',
  requireAuth,
  requireRole('customer'),
  enforce((req) => `purchase-request:${req.authUser.sub}`, 10, 3600, 'Too many purchase requests. Please wait before trying again.'),
  wrap(async (req, res) => {
    const v = new Validator(req.body);
    v.required('property_id').integer('property_id');
    if (v.fails()) return response.validationError(res, v.errors());
    const data = v.validated();

    const property = await Property.findById(Number(data.property_id));
    if (!property) return response.notFound(res, 'Property not found.');
    if (property.listing_type !== 'sale') {
      return response.validationError(res, { property_id: ['This property is not listed for sale.'] });
    }
    if (property.status !== 'approved') {
      return response.validationError(res, { property_id: ['This property is not currently available.'] });
    }

    const alreadyOpen = await PropertyPurchase.hasOpenRequest(req.authUser.sub, property.id);
    if (alreadyOpen) {
      return response.validationError(res, { property_id: ['You already have an open request for this property.'] });
    }

    const id = await PropertyPurchase.request(null, {
      buyer_user_id: req.authUser.sub,
      property_id: property.id,
      agreed_price: property.price,
    });

    await Notification.create(
      req.authUser.sub,
      'property_purchase',
      'Purchase request sent',
      `Your request to buy "${property.title}" has been sent to the listing agent for review.`
    );

    // Same lister-notification gap as viewings/rentals -- see that
    // route's comment. Company account gets it for a company listing
    // (it assigns which realtor follows up), the individual agent
    // otherwise.
    const listerNotifyUserId = property.company_id ? property.company_user_id : property.listed_by_user_id;
    if (listerNotifyUserId) {
      await Notification.create(
        listerNotifyUserId,
        'property_purchase',
        'New purchase request',
        `A customer has requested to buy "${property.title}".`
      );
    }

    logger.info('Property purchase requested', {
      purchase_id: id,
      buyer_user_id: req.authUser.sub,
      property_id: property.id,
    });
    return response.created(res, { id }, 'Purchase request sent.');
  })
);

/** POST /purchases/:id/cancel (customer) — withdraw your own still-open request */
router.post(
  '/:id/cancel',
  requireAuth,
  requireRole('customer'),
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const ok = await PropertyPurchase.cancelOwnRequest(id, req.authUser.sub);
    if (!ok) return response.notFound(res, 'Purchase request not found or already handled.');
    return response.success(res, null, 'Purchase request cancelled.');
  })
);

/**
 * GET /purchases/for-my-listings (agent/company) — every purchase
 * against a property this user lists, for the Revenue and
 * Transactions pages. Deliberately not open to admin here (admin has
 * its own platform-wide views) or to the buyer (that's /mine above).
 */
router.get(
  '/for-my-listings',
  requireAuth,
  requireRole('agent', 'company'),
  wrap(async (req, res) => {
    const companyId = await resolveCallerCompanyId(req.authUser);
    const rows = await PropertyPurchase.forLister(req.authUser.sub, companyId, req.query.status || null);
    return response.success(res, rows);
  })
);

/**
 * POST /purchases/:id/confirm (admin, or the property's own listing
 * agent/company) — the manual counterpart to a Paystack webhook. Marks
 * the purchase completed, the property sold, the matching transaction
 * successful, cancels any other pending intents on the same property,
 * and notifies the buyer.
 */
router.post(
  '/:id/confirm',
  requireAuth,
  requireRole('admin', 'company', 'agent'),
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const purchase = await PropertyPurchase.findById(id);
    if (!purchase) return response.notFound(res, 'Purchase not found.');
    if (!['pending_payment', 'processing'].includes(purchase.status)) {
      return response.validationError(res, { status: ['This purchase is not awaiting confirmation.'] });
    }

    const property = await Property.findById(purchase.property_id);
    if (req.authUser.role !== 'admin' && property.listed_by_user_id !== req.authUser.sub) {
      logger.security('Blocked IDOR attempt on purchase confirmation', {
        purchase_id: id,
        attempted_by: req.authUser.sub,
      });
      return response.forbidden(res, 'You do not have permission to confirm this purchase.');
    }
    if (property.status === 'sold') {
      return response.validationError(res, { status: ['This property has already been sold.'] });
    }

    await withTransaction(async (conn) => {
      await PropertyPurchase.complete(conn, id);
      await PropertyPurchase.cancelOtherPending(conn, purchase.property_id, id);
      const txn = await Transaction.findByReference('property_purchases', id, 'property_purchase');
      if (txn) await Transaction.markStatus(conn, txn.id, 'success');
    });
    await Property.markSold(purchase.property_id);

    await Notification.create(
      purchase.buyer_user_id,
      'property_purchase',
      'Purchase confirmed',
      `Your purchase of "${property.title}" has been confirmed.`
    );
    const buyerForSms = await User.findById(purchase.buyer_user_id);
    await sendSms(buyerForSms?.phone, `HouseBank: your purchase of "${property.title}" has been confirmed.`);

    logger.security('Property purchase confirmed', { purchase_id: id, confirmed_by: req.authUser.sub });
    return response.success(res, null, 'Purchase confirmed.');
  })
);

/**
 * POST /purchases/:id/approve (admin, or the property's own listing
 * agent/company) — approves a customer-submitted request, promoting it
 * to the same 'pending_payment' state POST / creates directly, and only
 * now opens the matching Transaction — no money is implied to have
 * moved before this point. Optional `note` is stored and passed back to
 * the buyer in their notification.
 */
router.post(
  '/:id/approve',
  requireAuth,
  requireRole('admin', 'company', 'agent'),
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const purchase = await PropertyPurchase.findById(id);
    if (!purchase) return response.notFound(res, 'Purchase request not found.');
    if (purchase.status !== 'requested') {
      return response.validationError(res, { status: ['This request has already been handled.'] });
    }

    const property = await Property.findById(purchase.property_id);
    if (req.authUser.role !== 'admin' && property.listed_by_user_id !== req.authUser.sub) {
      logger.security('Blocked IDOR attempt on purchase approval', {
        purchase_id: id,
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

    await withTransaction(async (conn) => {
      await PropertyPurchase.approve(conn, id, note);
      await Transaction.create(conn, {
        user_id: purchase.buyer_user_id,
        type: 'property_purchase',
        reference_table: 'property_purchases',
        reference_id: id,
        amount: purchase.agreed_price,
        payment_method: 'manual_transfer',
      });
    });

    await Notification.create(
      purchase.buyer_user_id,
      'property_purchase',
      'Purchase request approved',
      `Your request to buy "${property.title}" has been approved and recorded. It's now awaiting final confirmation.`
    );

    logger.security('Property purchase request approved', { purchase_id: id, approved_by: req.authUser.sub });
    return response.success(res, null, 'Purchase request approved.');
  })
);

/**
 * POST /purchases/:id/decline (admin, or the property's own listing
 * agent/company) — rejects a customer-submitted request. No property or
 * Transaction side effects; the customer can submit a fresh request.
 */
router.post(
  '/:id/decline',
  requireAuth,
  requireRole('admin', 'company', 'agent'),
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const purchase = await PropertyPurchase.findById(id);
    if (!purchase) return response.notFound(res, 'Purchase request not found.');
    if (purchase.status !== 'requested') {
      return response.validationError(res, { status: ['This request has already been handled.'] });
    }

    const property = await Property.findById(purchase.property_id);
    if (req.authUser.role !== 'admin' && property.listed_by_user_id !== req.authUser.sub) {
      logger.security('Blocked IDOR attempt on purchase decline', {
        purchase_id: id,
        attempted_by: req.authUser.sub,
      });
      return response.forbidden(res, 'You do not have permission to decline this request.');
    }

    const v = new Validator(req.body);
    v.max('note', 500);
    if (v.fails()) return response.validationError(res, v.errors());
    const note = v.validated().note || null;

    await PropertyPurchase.decline(id, note);

    await Notification.create(
      purchase.buyer_user_id,
      'property_purchase',
      'Purchase request declined',
      note
        ? `Your request to buy "${property.title}" was declined: ${note}`
        : `Your request to buy "${property.title}" was declined.`
    );

    logger.info('Property purchase request declined', { purchase_id: id, declined_by: req.authUser.sub });
    return response.success(res, null, 'Purchase request declined.');
  })
);

module.exports = router;
