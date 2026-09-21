'use strict';

const express = require('express');
const { withTransaction } = require('../../config/db');
const { Validator } = require('../../utils/validator');
const response = require('../../utils/response');
const { logger } = require('../../utils/logger');
const { requireAuth, requireRole } = require('../../middleware/auth');
const InvestmentProperty = require('../../models/InvestmentProperty');
const Investment = require('../../models/Investment');
const Transaction = require('../../models/Transaction');
const Notification = require('../../models/Notification');
const Property = require('../../models/Property');
const PropertyImage = require('../../models/PropertyImage');
const User = require('../../models/User');
const { sendSms } = require('../../utils/sms');

const router = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

/** GET /investments/opportunities (public) — open investment listings */
router.get(
  '/opportunities',
  wrap(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = Math.min(50, Math.max(1, parseInt(req.query.per_page, 10) || 12));
    const result = await InvestmentProperty.findOpen({
      page,
      perPage,
      status: ['open', 'fully_funded', 'closed', 'matured'].includes(req.query.status) ? req.query.status : undefined,
      q: req.query.q || undefined,
      min_amount: req.query.min_amount || undefined,
      max_amount: req.query.max_amount || undefined,
    });
    return response.success(res, result);
  })
);

router.get(
  '/opportunities/by-property/:propertyId',
  wrap(async (req, res) => {
    const opp = await InvestmentProperty.findByPropertyId(Number(req.params.propertyId));
    if (!opp) return response.notFound(res, 'No investment opportunity configured for this property.');
    return response.success(res, opp);
  })
);

router.get(
  '/opportunities/:id',
  wrap(async (req, res) => {
    const opp = await InvestmentProperty.findById(Number(req.params.id));
    if (!opp) return response.notFound(res, 'Investment opportunity not found.');
    opp.images = await PropertyImage.forProperty(opp.property_id);
    return response.success(res, opp);
  })
);

/** POST /investments/opportunities (protected — the property's own agent/company, or admin) */
router.post(
  '/opportunities',
  requireAuth,
  requireRole('agent', 'company', 'admin'),
  wrap(async (req, res) => {
    const v = new Validator(req.body);
    v.required('property_id').integer('property_id');
    v.required('total_target_amount').numeric('total_target_amount').minValue('total_target_amount', 1);
    v.required('min_investment_amount').numeric('min_investment_amount').minValue('min_investment_amount', 1);
    v.required('expected_roi_percent').numeric('expected_roi_percent').minValue('expected_roi_percent', 0);
    v.required('tenure_months').integer('tenure_months').minValue('tenure_months', 1);
    if (v.fails()) return response.validationError(res, v.errors());
    const data = v.validated();

    const property = await Property.findById(Number(data.property_id));
    if (!property) return response.notFound(res, 'Property not found.');
    if (req.authUser.role !== 'admin' && property.listed_by_user_id !== req.authUser.sub) {
      logger.security('Blocked IDOR attempt on investment opportunity creation', {
        property_id: data.property_id,
        attempted_by: req.authUser.sub,
      });
      return response.forbidden(res, 'You do not have permission to create an investment listing for this property.');
    }

    const id = await InvestmentProperty.create({
      property_id: Number(data.property_id),
      total_target_amount: data.total_target_amount,
      min_investment_amount: data.min_investment_amount,
      expected_roi_percent: data.expected_roi_percent,
      tenure_months: Number(data.tenure_months),
      maturity_date: data.maturity_date || null,
    });
    return response.created(res, { id }, 'Investment opportunity created.');
  })
);

/** GET /investments/mine (protected) — the current user's own investments */
router.get(
  '/mine',
  requireAuth,
  wrap(async (req, res) => {
    const rows = await Investment.forInvestor(req.authUser.sub);
    return response.success(res, rows);
  })
);

/** GET /investments/stats (protected) — aggregate card data for the dashboard */
router.get(
  '/stats',
  requireAuth,
  wrap(async (req, res) => {
    const stats = await Investment.statsForInvestor(req.authUser.sub);
    return response.success(res, stats);
  })
);

/**
 * POST /investments (protected) — records investment INTENT only. No
 * live payment gateway is wired up yet (see docs/ROADMAP.md — Paystack
 * integration is a separate, deliberate task requiring real API keys).
 * This creates a 'pending_payment' investment plus a matching 'pending'
 * transaction, mirroring the manual-transfer path already modeled in
 * the schema. POST /investments/:id/confirm is what moves it from
 * intent to active once payment is actually confirmed.
 */
router.post(
  '/',
  requireAuth,
  wrap(async (req, res) => {
    const v = new Validator(req.body);
    v.required('investment_property_id').integer('investment_property_id');
    v.required('amount').numeric('amount').minValue('amount', 1);
    if (v.fails()) return response.validationError(res, v.errors());
    const data = v.validated();

    const opp = await InvestmentProperty.findById(Number(data.investment_property_id));
    if (!opp) return response.notFound(res, 'Investment opportunity not found.');
    if (opp.status !== 'open') {
      return response.validationError(res, { investment_property_id: ['This investment is no longer open.'] });
    }
    if (Number(data.amount) < Number(opp.min_investment_amount)) {
      return response.validationError(res, { amount: [`Minimum investment is ${opp.min_investment_amount}.`] });
    }

    const investmentId = await withTransaction(async (conn) => {
      const id = await Investment.create(conn, {
        investor_user_id: req.authUser.sub,
        investment_property_id: Number(data.investment_property_id),
        amount: data.amount,
      });
      await Transaction.create(conn, {
        user_id: req.authUser.sub,
        type: 'investment',
        reference_table: 'investments',
        reference_id: id,
        amount: data.amount,
        payment_method: 'manual_transfer',
      });
      return id;
    });

    logger.info('Investment intent created', { investment_id: investmentId, user_id: req.authUser.sub });
    return response.created(res, { id: investmentId }, 'Investment recorded — pending payment confirmation.');
  })
);

/**
 * POST /investments/:id/confirm (protected — admin, or the company that
 * owns the underlying property) — the manual counterpart to a Paystack
 * webhook: marks a pending investment active once payment has actually
 * been confirmed outside the app, bumps the opportunity's amount_raised,
 * and marks the matching transaction successful.
 */
router.post(
  '/:id/confirm',
  requireAuth,
  requireRole('admin', 'company', 'agent'),
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const investment = await Investment.findById(id);
    if (!investment) return response.notFound(res, 'Investment not found.');
    if (investment.status !== 'pending_payment') {
      return response.validationError(res, { status: ['This investment is not pending payment.'] });
    }

    const opp = await InvestmentProperty.findById(investment.investment_property_id);
    if (req.authUser.role !== 'admin' && opp.listed_by_user_id !== req.authUser.sub) {
      logger.security('Blocked IDOR attempt on investment confirmation', {
        investment_id: id,
        attempted_by: req.authUser.sub,
      });
      return response.forbidden(res, 'You do not have permission to confirm this investment.');
    }

    await withTransaction(async (conn) => {
      await Investment.markActive(conn, id);
      await InvestmentProperty.addToAmountRaised(investment.investment_property_id, investment.amount);
      const txn = await Transaction.findByReference('investments', id, 'investment');
      if (txn) await Transaction.markStatus(conn, txn.id, 'success');
    });

    await Notification.create(
      investment.investor_user_id,
      'investment',
      'Investment confirmed',
      `Your investment of ${investment.amount} has been confirmed and is now active.`
    );
    const investorForSms = await User.findById(investment.investor_user_id);
    await sendSms(investorForSms?.phone, `HouseBank: your investment of ${investment.amount} has been confirmed and is now active.`);

    logger.security('Investment payment confirmed', { investment_id: id, confirmed_by: req.authUser.sub });
    return response.success(res, null, 'Investment confirmed and activated.');
  })
);

module.exports = router;
