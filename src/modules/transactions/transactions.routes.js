'use strict';

const express = require('express');
const response = require('../../utils/response');
const { requireAuth } = require('../../middleware/auth');
const Transaction = require('../../models/Transaction');

const router = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

/** GET /transactions/mine (protected) — the current user's own transaction history */
router.get(
  '/mine',
  requireAuth,
  wrap(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = Math.min(50, Math.max(1, parseInt(req.query.per_page, 10) || 20));
    const result = await Transaction.forUser(req.authUser.sub, page, perPage);
    return response.success(res, result);
  })
);

module.exports = router;
