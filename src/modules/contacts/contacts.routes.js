'use strict';

const express = require('express');
const response = require('../../utils/response');
const { requireAuth, requireRole } = require('../../middleware/auth');
const Contact = require('../../models/Contact');
const { resolveCallerCompanyId } = require('../../utils/companyScope');

const router = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

/**
 * GET /contacts/mine — for a customer: the real agents/companies they
 * have an actual relationship with, derived from their own
 * viewings/purchases/rentals/investments ("my realtor"). For an
 * agent/company: the real customers who've viewed, bought, or rented
 * one of their listings ("my customers"). Either way this is not a
 * directory of every user on the platform, and each entry here is
 * exactly who the caller is allowed to message (see modules/messages,
 * which authorizes against these same two lists).
 */
router.get(
  '/mine',
  requireAuth,
  requireRole('customer', 'agent', 'company', 'admin'),
  wrap(async (req, res) => {
    let contacts;
    if (req.authUser.role === 'customer') {
      contacts = await Contact.forCustomer(req.authUser.sub);
    } else if (req.authUser.role === 'admin') {
      // Every company on the platform — see Contact.forAdmin()'s doc
      // comment for why this one deliberately skips the relationship
      // check the other two branches enforce.
      contacts = await Contact.forAdmin();
    } else {
      const companyId = await resolveCallerCompanyId(req.authUser);
      contacts = await Contact.forLister(req.authUser.sub, companyId);
    }
    return response.success(res, contacts);
  })
);

module.exports = router;
