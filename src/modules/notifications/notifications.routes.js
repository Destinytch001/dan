'use strict';

const express = require('express');
const response = require('../../utils/response');
const { requireAuth } = require('../../middleware/auth');
const Notification = require('../../models/Notification');

const router = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

/** GET /notifications (protected) — the current user's own notifications, paginated */
router.get(
  '/',
  requireAuth,
  wrap(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = Math.min(50, Math.max(1, parseInt(req.query.per_page, 10) || 20));
    const unreadOnly = req.query.unread === '1' || req.query.unread === 'true';
    const result = await Notification.forUser(req.authUser.sub, { unreadOnly, page, perPage });
    return response.success(res, result);
  })
);

router.get(
  '/unread-count',
  requireAuth,
  wrap(async (req, res) => {
    const count = await Notification.unreadCount(req.authUser.sub);
    return response.success(res, { count });
  })
);

/** POST /notifications/:id/read (protected) — ownership enforced inside the model's UPDATE itself */
router.post(
  '/:id/read',
  requireAuth,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const ok = await Notification.markRead(id, req.authUser.sub);
    if (!ok) return response.notFound(res, 'Notification not found.');
    return response.success(res, null, 'Marked as read.');
  })
);

router.post(
  '/read-all',
  requireAuth,
  wrap(async (req, res) => {
    await Notification.markAllRead(req.authUser.sub);
    return response.success(res, null, 'All notifications marked as read.');
  })
);

module.exports = router;
