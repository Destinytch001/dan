'use strict';

const express = require('express');
const { Validator } = require('../../utils/validator');
const response = require('../../utils/response');
const { logger } = require('../../utils/logger');
const { requireAuth, requireRole } = require('../../middleware/auth');
const Property = require('../../models/Property');
const Notification = require('../../models/Notification');
const PropertyAppeal = require('../../models/PropertyAppeal');
const AdminStats = require('../../models/AdminStats');
const PropertyImage = require('../../models/PropertyImage');
const Company = require('../../models/Company');
const AgentProfile = require('../../models/AgentProfile');
const CustomerProfile = require('../../models/CustomerProfile');
const User = require('../../models/User');
const fs = require('fs');
const path = require('path');
const { STORAGE_ROOT } = require('../../utils/fileUpload');
const { sendSms } = require('../../utils/sms');

const router = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// Every route in this file is admin-only.
router.use(requireAuth, requireRole('admin'));

// Joan, Sep 2026: admin no longer vets individual property listings --
// "the admin only vets and approves companies... its the company that
// vets and approves properties." The old /properties/pending,
// /properties/:id/approve and /properties/:id/reject routes (admin
// re-approving a listing its own company had already vetted) are
// removed. Admin's remaining property powers are post-publish
// moderation only -- flag/unflag/block below, resolved through the
// appeals routes further down. See Property.approve/reject/findPending
// in the model file -- left in place but unused.

/** GET /admin/overview — real numbers for the admin dashboard (Overview.tsx was static sample data before this). */
router.get(
  '/overview',
  wrap(async (req, res) => {
    const [counts, platformGrowth, propertiesTrend, topCompanies, recentlyAddedProperties] = await Promise.all([
      AdminStats.counts(),
      AdminStats.platformGrowth(),
      AdminStats.propertiesTrend(7),
      AdminStats.topCompanies(3),
      AdminStats.recentlyAddedProperties(5),
    ]);
    const recentActivity = await Notification.platformFeed({ page: 1, perPage: 5 });
    return response.success(res, {
      counts,
      platform_growth: platformGrowth,
      properties_trend: propertiesTrend,
      top_companies: topCompanies,
      recently_added_properties: recentlyAddedProperties,
      recent_activity: recentActivity.data,
    });
  })
);

/** GET /admin/notifications — the platform-wide activity feed (see Notification.platformFeed for why this isn't a per-user inbox). */
router.get(
  '/notifications',
  wrap(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = Math.min(50, Math.max(1, parseInt(req.query.per_page, 10) || 20));
    const result = await Notification.platformFeed({ page, perPage });
    return response.success(res, result);
  })
);

/** GET /admin/properties — every listing, any status, for the admin property console (not just the pending queue). */
router.get(
  '/properties',
  wrap(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = Math.min(50, Math.max(1, parseInt(req.query.per_page, 10) || 20));
    const result = await Property.findAllForAdmin(
      { status: req.query.status, q: req.query.q, flagged: req.query.flagged },
      page,
      perPage
    );
    return response.success(res, result);
  })
);

/** GET /admin/properties/:id — full detail for the admin property console, any status, including images and appeal history. */
router.get(
  '/properties/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const property = await Property.findById(id);
    if (!property) return response.notFound(res, 'Property not found.');
    const [images, appeals] = await Promise.all([
      PropertyImage.forProperty(id),
      PropertyAppeal.findForProperty(id),
    ]);
    return response.success(res, { ...property, images, appeals });
  })
);

/** POST /admin/properties/:id/flag — Body: { reason }. Soft marker — does not unpublish, just records the concern and tells whoever listed it. */
router.post(
  '/properties/:id/flag',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const property = await Property.findById(id);
    if (!property) return response.notFound(res, 'Property not found.');

    const v = new Validator(req.body);
    v.required('reason').max('reason', 255);
    if (v.fails()) return response.validationError(res, v.errors());

    await Property.flag(id, req.authUser.sub, String(req.body.reason));
    await Notification.create(
      property.listed_by_user_id,
      'realtor_listing',
      'Listing flagged for review',
      `HouseBank flagged "${property.title}": ${req.body.reason}. It's still live, but please address this — an unresolved flag can lead to the listing being blocked.`
    );
    logger.security('Property flagged', { property_id: id, admin_id: req.authUser.sub });
    return response.success(res, null, 'Property flagged.');
  })
);

/** POST /admin/properties/:id/unflag — clears a flag once resolved, no notification needed (nothing changed from the public's view). */
router.post(
  '/properties/:id/unflag',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const property = await Property.findById(id);
    if (!property) return response.notFound(res, 'Property not found.');
    await Property.unflag(id);
    logger.security('Property flag cleared', { property_id: id, admin_id: req.authUser.sub });
    return response.success(res, null, 'Flag cleared.');
  })
);

/** POST /admin/properties/:id/block — Body: { reason }. Hard action — drops out of every public query until an appeal is approved. */
router.post(
  '/properties/:id/block',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const property = await Property.findById(id);
    if (!property) return response.notFound(res, 'Property not found.');

    const v = new Validator(req.body);
    v.required('reason').max('reason', 255);
    if (v.fails()) return response.validationError(res, v.errors());

    await Property.block(id, req.authUser.sub, String(req.body.reason));
    await Notification.create(
      property.listed_by_user_id,
      'realtor_listing',
      'Listing blocked',
      `HouseBank blocked "${property.title}": ${req.body.reason}. It's no longer visible to the public. Submit an appeal from your property dashboard to request it be reinstated.`
    );
    logger.security('Property blocked', { property_id: id, admin_id: req.authUser.sub });
    return response.success(res, null, 'Property blocked.');
  })
);

/** GET /admin/appeals — the pending-appeal queue, same shape as the pending-listing queue. */
router.get(
  '/appeals',
  wrap(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = Math.min(50, Math.max(1, parseInt(req.query.per_page, 10) || 20));
    const result = await PropertyAppeal.findPendingForAdmin(page, perPage);
    return response.success(res, result);
  })
);

/** POST /admin/appeals/:id/resolve — Body: { decision: 'approved'|'rejected', response? }. Approving unblocks the listing; rejecting leaves it blocked. */
router.post(
  '/appeals/:id/resolve',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const appeal = await PropertyAppeal.findById(id);
    if (!appeal) return response.notFound(res, 'Appeal not found.');
    if (appeal.status !== 'pending') {
      return response.validationError(res, { status: ['This appeal has already been resolved.'] });
    }

    const v = new Validator(req.body);
    v.required('decision').in('decision', ['approved', 'rejected']);
    if (v.fails()) return response.validationError(res, v.errors());

    const decision = req.body.decision;
    const adminResponse = req.body.response ? String(req.body.response).slice(0, 255) : null;

    await PropertyAppeal.resolve(id, req.authUser.sub, decision, adminResponse);

    const property = await Property.findById(appeal.property_id);
    if (decision === 'approved') {
      await Property.unblock(appeal.property_id);
      await Notification.create(
        appeal.submitted_by_user_id,
        'realtor_listing',
        'Appeal approved',
        `Your appeal for "${property ? property.title : 'your listing'}" was approved — it's live again.${adminResponse ? ` HouseBank: ${adminResponse}` : ''}`
      );
    } else {
      await Notification.create(
        appeal.submitted_by_user_id,
        'realtor_listing',
        'Appeal rejected',
        `Your appeal for "${property ? property.title : 'your listing'}" was rejected — it remains blocked.${adminResponse ? ` HouseBank: ${adminResponse}` : ''}`
      );
    }

    logger.security('Property appeal resolved', { appeal_id: id, decision, admin_id: req.authUser.sub });
    return response.success(res, null, 'Appeal resolved.');
  })
);

// ─────────────────────────────────────────────────────────────────────────
// Company verification -- this is admin's real, primary job now (Joan,
// Sep 2026: "the admin only vets and approves companies"). Every
// company can self-register and use the platform immediately
// (verification_status never gated login), but an unverified company's
// listings carry the amber "Unverified" badge everywhere on the public
// site until admin verifies it here.
// ─────────────────────────────────────────────────────────────────────────

/** GET /admin/companies */
router.get(
  '/companies',
  wrap(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = Math.min(50, Math.max(1, parseInt(req.query.per_page, 10) || 20));
    const status = ['pending', 'verified', 'rejected'].includes(req.query.status) ? req.query.status : undefined;
    const result = await Company.listForAdmin({ status, q: req.query.q }, page, perPage);
    return response.success(res, result);
  })
);

/** GET /admin/companies/:id */
router.get(
  '/companies/:id',
  wrap(async (req, res) => {
    const company = await Company.findByIdForAdmin(Number(req.params.id));
    if (!company) return response.notFound(res, 'Company not found.');
    return response.success(res, company);
  })
);

/**
 * GET /admin/companies/:id/cac-document -- the gated private-document
 * download this build never had (roadmap item 1). cac_document_path
 * is never client-supplied -- it's whatever storeDocument() wrote at
 * signup -- but the STORAGE_ROOT containment check stays as a second,
 * defense-in-depth gate against a corrupted/legacy path ever escaping
 * storage/uploads/documents.
 */
router.get(
  '/companies/:id/cac-document',
  wrap(async (req, res) => {
    const company = await Company.findByIdForAdmin(Number(req.params.id));
    if (!company || !company.cac_document_path) return response.notFound(res, 'Document not found.');

    const documentsRoot = path.join(STORAGE_ROOT, 'uploads', 'documents');
    const resolved = path.resolve(company.cac_document_path);
    if (!resolved.startsWith(documentsRoot + path.sep)) {
      logger.security('Blocked suspicious CAC document path', { company_id: company.id, admin_id: req.authUser.sub });
      return response.notFound(res, 'Document not found.');
    }
    if (!fs.existsSync(resolved)) return response.notFound(res, 'Document not found.');

    logger.security('Admin viewed company CAC document', { company_id: company.id, admin_id: req.authUser.sub });
    return res.sendFile(resolved);
  })
);

/** POST /admin/companies/:id/verify — Body: { notes? } */
router.post(
  '/companies/:id/verify',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const company = await Company.findByIdForAdmin(id);
    if (!company) return response.notFound(res, 'Company not found.');

    await Company.verify(id, req.authUser.sub, req.body.notes ? String(req.body.notes).slice(0, 255) : null);
    await Notification.create(
      company.user_id,
      'account',
      'Company verified',
      `HouseBank has verified ${company.company_name}. Your listings now show as verified to customers.`
    );
    const companyOwnerForSms = await User.findById(company.user_id);
    await sendSms(
      companyOwnerForSms?.phone,
      `HouseBank has verified ${company.company_name}. Your listings now show as verified to customers.`
    );
    logger.security('Company verified', { company_id: id, admin_id: req.authUser.sub });
    return response.success(res, null, 'Company verified.');
  })
);

/** POST /admin/companies/:id/reject — Body: { notes } */
router.post(
  '/companies/:id/reject',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const company = await Company.findByIdForAdmin(id);
    if (!company) return response.notFound(res, 'Company not found.');

    const v = new Validator(req.body);
    v.required('notes').max('notes', 255);
    if (v.fails()) return response.validationError(res, v.errors());

    await Company.rejectVerification(id, req.authUser.sub, String(req.body.notes));
    await Notification.create(
      company.user_id,
      'account',
      'Verification not approved',
      `HouseBank could not verify ${company.company_name}: ${req.body.notes}`
    );
    const companyOwnerForRejectSms = await User.findById(company.user_id);
    await sendSms(
      companyOwnerForRejectSms?.phone,
      `HouseBank could not verify ${company.company_name}: ${req.body.notes}`
    );
    logger.security('Company verification rejected', { company_id: id, admin_id: req.authUser.sub });
    return response.success(res, null, 'Verification rejected.');
  })
);

// ─────────────────────────────────────────────────────────────────────────
// Realtor / customer directories + account status (Joan, Sep 2026:
// "/admin/realtors" and "/admin/customers" were still static). Suspend/
// activate is the one real, schema-backed action here (users.status is
// already enforced at signin/refresh) -- deliberately not usable on an
// admin account, so this can't be used to lock another admin out.
// ─────────────────────────────────────────────────────────────────────────

/** GET /admin/realtors */
router.get(
  '/realtors',
  wrap(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = Math.min(50, Math.max(1, parseInt(req.query.per_page, 10) || 20));
    const accountStatus = ['active', 'suspended', 'banned', 'pending_verification'].includes(req.query.status)
      ? req.query.status
      : undefined;
    const result = await AgentProfile.listForAdmin({ q: req.query.q, accountStatus }, page, perPage);
    return response.success(res, result);
  })
);

/** GET /admin/customers */
router.get(
  '/customers',
  wrap(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = Math.min(50, Math.max(1, parseInt(req.query.per_page, 10) || 20));
    const accountStatus = ['active', 'suspended', 'banned', 'pending_verification'].includes(req.query.status)
      ? req.query.status
      : undefined;
    const result = await CustomerProfile.listForAdmin({ q: req.query.q, accountStatus }, page, perPage);
    return response.success(res, result);
  })
);

/** POST /admin/users/:id/suspend — realtor or customer accounts only, never admin. */
router.post(
  '/users/:id/suspend',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const user = await User.findById(id);
    if (!user) return response.notFound(res, 'User not found.');
    if (user.role === 'admin') {
      logger.security('Blocked attempt to suspend an admin account', { target_user_id: id, admin_id: req.authUser.sub });
      return response.forbidden(res, 'Admin accounts cannot be suspended from here.');
    }
    await User.setStatus(id, 'suspended');
    await Notification.create(id, 'account', 'Account suspended', 'Your HouseBank account has been suspended by an administrator.');
    logger.security('Account suspended', { target_user_id: id, admin_id: req.authUser.sub });
    return response.success(res, null, 'Account suspended.');
  })
);

/** POST /admin/users/:id/activate */
router.post(
  '/users/:id/activate',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const user = await User.findById(id);
    if (!user) return response.notFound(res, 'User not found.');
    await User.setStatus(id, 'active');
    await Notification.create(id, 'account', 'Account reactivated', 'Your HouseBank account has been reactivated.');
    logger.security('Account reactivated', { target_user_id: id, admin_id: req.authUser.sub });
    return response.success(res, null, 'Account reactivated.');
  })
);

module.exports = router;
