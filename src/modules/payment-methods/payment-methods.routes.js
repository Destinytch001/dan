'use strict';

const express = require('express');
const { Validator } = require('../../utils/validator');
const response = require('../../utils/response');
const { logger } = require('../../utils/logger');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { enforce } = require('../../utils/rateLimiter');
const PaymentMethod = require('../../models/PaymentMethod');

const router = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// Recognizable card brands only — this is a label on a saved-reference
// card, not something a payment gateway is asked to charge, but keeping
// it to a closed list still stops the field turning into a free-text
// dumping ground.
const ALLOWED_BRANDS = ['visa', 'mastercard', 'verve', 'american_express', 'discover', 'other'];

/**
 * Saved-card "on file" reference metadata for customers — brand, last 4
 * digits, expiry, cardholder name. There is deliberately no field
 * anywhere in this router, its validation, or the underlying table for
 * a full card number or a CVV/CVC. Collecting and storing those on a
 * shared-hosting MySQL database with no PCI-DSS compliance program
 * behind it would be a serious security failure, not a convenience —
 * so this is structurally impossible here, not merely undocumented.
 * Actually charging a card still requires a real gateway integration
 * (Paystack, per docs/ROADMAP.md) that tokenizes the card on ITS
 * PCI-compliant servers and only ever hands this app back exactly this
 * kind of safe metadata.
 */

/** GET /payment-methods/mine (protected — customer only) */
router.get(
  '/mine',
  requireAuth,
  requireRole('customer'),
  wrap(async (req, res) => {
    const cards = await PaymentMethod.forCustomer(req.authUser.sub);
    return response.success(res, cards);
  })
);

/** POST /payment-methods (protected — customer only) */
router.post(
  '/',
  requireAuth,
  requireRole('customer'),
  enforce((req) => `payment-method-add:${req.authUser.sub}`, 10, 3600, 'Too many cards added. Please wait before adding more.'),
  wrap(async (req, res) => {
    const v = new Validator(req.body);
    v.required('card_brand').in('card_brand', ALLOWED_BRANDS);
    v.required('last4').regex('last4', /^\d{4}$/, 'Must be exactly 4 digits.');
    v.required('expiry_month').integer('expiry_month');
    v.required('expiry_year').integer('expiry_year');
    v.required('cardholder_name').max('cardholder_name', 150);
    if (v.fails()) return response.validationError(res, v.errors());

    const month = Number(req.body.expiry_month);
    const year = Number(req.body.expiry_year);
    if (month < 1 || month > 12) {
      return response.validationError(res, { expiry_month: ['Must be between 1 and 12.'] });
    }

    const now = new Date();
    const currentYear = now.getUTCFullYear();
    const currentMonth = now.getUTCMonth() + 1;
    if (year < currentYear || (year === currentYear && month < currentMonth)) {
      return response.validationError(res, { expiry_year: ['This card has already expired.'] });
    }

    const count = await PaymentMethod.countForCustomer(req.authUser.sub);
    if (count >= 10) {
      return response.validationError(res, { _: ['You can save at most 10 cards.'] });
    }

    const id = await PaymentMethod.create(req.authUser.sub, {
      card_brand: req.body.card_brand,
      last4: req.body.last4,
      expiry_month: month,
      expiry_year: year,
      cardholder_name: req.body.cardholder_name,
    });

    return response.created(res, { id }, 'Card saved.');
  })
);

/** DELETE /payment-methods/:id (protected — customer, owner only) */
router.delete(
  '/:id',
  requireAuth,
  requireRole('customer'),
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const removed = await PaymentMethod.remove(id, req.authUser.sub);
    if (!removed) {
      logger.security('Blocked attempt to delete a payment method not owned by caller', {
        payment_method_id: id,
        attempted_by: req.authUser.sub,
      });
      return response.notFound(res, 'Card not found.');
    }
    return response.success(res, null, 'Card removed.');
  })
);

/** POST /payment-methods/:id/default (protected — customer, owner only) */
router.post(
  '/:id/default',
  requireAuth,
  requireRole('customer'),
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const updated = await PaymentMethod.setDefault(id, req.authUser.sub);
    if (!updated) {
      return response.notFound(res, 'Card not found.');
    }
    return response.success(res, null, 'Default card updated.');
  })
);

module.exports = router;
