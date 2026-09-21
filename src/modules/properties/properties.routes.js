'use strict';

const express = require('express');
const { pool } = require('../../config/db');
const { Validator } = require('../../utils/validator');
const response = require('../../utils/response');
const { logger } = require('../../utils/logger');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { enforce } = require('../../utils/rateLimiter');
const { upload, storeImage } = require('../../utils/fileUpload');
const Property = require('../../models/Property');
const PropertyImage = require('../../models/PropertyImage');
const Company = require('../../models/Company');
const AgentProfile = require('../../models/AgentProfile');
const Notification = require('../../models/Notification');
const { resolveCallerCompanyId } = require('../../utils/companyScope');
const PropertyAppeal = require('../../models/PropertyAppeal');
const User = require('../../models/User');
const { sendSms } = require('../../utils/sms');

const router = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

/**
 * Every mutating action re-checks ownership server-side
 * (listed_by_user_id === authUser.sub, or role === admin) rather than
 * trusting anything the client sends about who owns what — the IDOR
 * defense. Without it, agent A could edit agent B's listing just by
 * guessing/incrementing an ID.
 */
async function authorizeOwnerOrAdmin(req, propertyId) {
  const property = await Property.findById(propertyId);
  if (!property) {
    const err = new Error('Property not found.');
    err.status = 404;
    throw err;
  }
  if (req.authUser.role !== 'admin' && property.listed_by_user_id !== req.authUser.sub) {
    logger.security('Blocked IDOR attempt on property', { property_id: propertyId, attempted_by: req.authUser.sub });
    const err = new Error('You do not have permission to modify this property.');
    err.status = 403;
    throw err;
  }
  return property;
}

/** GET /properties (public) — approved only, paginated/filterable */
router.get(
  '/',
  wrap(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = Math.min(50, Math.max(1, parseInt(req.query.per_page, 10) || 12));
    const filters = {
      listing_type: req.query.listing_type,
      city: req.query.city,
      state: req.query.state,
      property_type_id: req.query.property_type_id,
      min_price: req.query.min_price,
      max_price: req.query.max_price,
      q: req.query.q,
    };
    const result = await Property.searchApproved(filters, page, perPage);
    return response.success(res, result);
  })
);

/** GET /properties/types (public) */
router.get(
  '/types',
  wrap(async (req, res) => {
    const [rows] = await pool.execute('SELECT id, name FROM property_types ORDER BY name');
    return response.success(res, rows);
  })
);

/** GET /properties/mine (protected — agent/company) */
router.get(
  '/mine',
  requireAuth,
  requireRole('agent', 'company'),
  wrap(async (req, res) => {
    const status = req.query.status || null;
    const companyId = await resolveCallerCompanyId(req.authUser);
    const rows = await Property.findByListerId(req.authUser.sub, status, companyId);
    return response.success(res, rows);
  })
);

/**
 * GET /properties/mine/:id (protected — owner only, any status).
 * The public GET /:id below only ever returns approved listings, so an
 * agent/company has no way to see their own pending or rejected listing
 * (or its rejection_reason) through it. This is that endpoint — scoped
 * to the caller's own properties, no view-count bump (that metric is
 * about public interest, not the owner refreshing their own page).
 */
router.get(
  '/mine/:id',
  requireAuth,
  requireRole('agent', 'company'),
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const property = await Property.findById(id);
    if (!property) {
      return response.notFound(res, 'Property not found.');
    }
    // Own listing always passes. Otherwise, allow it only when the
    // caller is a company (or an agent attached to one) and this
    // property belongs to that same company — the same roster-wide
    // scope GET /mine already applies, so the "View" link on a
    // roster agent's listing doesn't 404 for the company that owns it.
    const isOwnListing = property.listed_by_user_id === req.authUser.sub;
    if (!isOwnListing) {
      const companyId = await resolveCallerCompanyId(req.authUser);
      const isCompanyRosterListing = companyId && property.company_id === companyId;
      if (!isCompanyRosterListing) {
        return response.notFound(res, 'Property not found.');
      }
    }
    property.images = await PropertyImage.forProperty(id);
    return response.success(res, property);
  })
);

/**
 * GET /properties/company-review (company only) — this company's own
 * agent-submitted listings still waiting on the company's own review,
 * before they ever reach HouseBank's admin queue. See migration 008
 * and Property.findPendingCompanyReview.
 */
router.get(
  '/company-review',
  requireAuth,
  requireRole('company'),
  wrap(async (req, res) => {
    const company = await Company.findByUserId(req.authUser.sub);
    if (!company) return response.notFound(res, 'Company profile not found.');
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = Math.min(50, Math.max(1, parseInt(req.query.per_page, 10) || 20));
    const result = await Property.findPendingCompanyReview(company.id, page, perPage);
    return response.success(res, result);
  })
);

/** GET /properties/:id (public) — approved only; increments views */
router.get(
  '/:id',
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const property = await Property.findById(id);
    if (!property || property.status !== 'approved') {
      return response.notFound(res, 'Property not found.');
    }
    await Property.incrementViews(id);
    property.images = await PropertyImage.forProperty(id);
    return response.success(res, property);
  })
);

/** POST /properties (protected — agent/company) */
router.post(
  '/',
  requireAuth,
  requireRole('agent', 'company'),
  enforce((req) => `property-create:${req.authUser.sub}`, 20, 3600, 'Too many listings submitted. Please wait before submitting more.'),
  wrap(async (req, res) => {
    const v = new Validator(req.body);
    v.required('property_type_id').integer('property_type_id');
    v.required('listing_type').in('listing_type', ['sale', 'rent', 'investment']);
    v.required('title').max('title', 191);
    v.required('price').numeric('price').minValue('price', 0);
    v.required('address').max('address', 255);
    v.required('city').max('city', 100);
    v.required('state').max('state', 100);
    if (v.fails()) return response.validationError(res, v.errors());
    const data = v.validated();
    const companyId = await resolveCallerCompanyId(req.authUser);

    // Joan, Sep 2026 -- correcting the original design: "the admin
    // only vets and approves companies... its the company that vets
    // and approves properties." An agent listing under a company must
    // still clear that company's own review first. A company listing
    // its own property is self-vetting by definition, same as a
    // company approving one of its agent's submissions below -- it
    // publishes immediately, no further review stage. (There's no
    // "independent agent with no company" case any more -- the
    // mandatory company-agent model means every agent has one.)
    const initialStatus = req.authUser.role === 'agent' && companyId ? 'pending_company_review' : 'approved';

    const propertyId = await Property.create({
      listed_by_user_id: req.authUser.sub,
      company_id: companyId,
      property_type_id: Number(data.property_type_id),
      listing_type: data.listing_type,
      title: data.title,
      slug: Property.slugify(data.title),
      description: data.description || null,
      price: data.price,
      bedrooms: data.bedrooms ?? null,
      bathrooms: data.bathrooms ?? null,
      size_sqm: data.size_sqm ?? null,
      address: data.address,
      city: data.city,
      state: data.state,
      latitude: data.latitude ?? null,
      longitude: data.longitude ?? null,
      status: initialStatus,
    });

    // A company (or an agent with no review stage in front of them)
    // publishes straight away -- stamp approved_by/approved_at the
    // same way Property.approve() would, so the record looks the same
    // as anything else that's live.
    if (initialStatus === 'approved') {
      await Property.approve(propertyId, req.authUser.sub);
    }

    logger.info('Property submitted', {
      property_id: propertyId,
      user_id: req.authUser.sub,
      initial_status: initialStatus,
    });

    return response.created(
      res,
      { id: propertyId },
      initialStatus === 'pending_company_review'
        ? 'Property submitted to your company for review.'
        : 'Property published.'
    );
  })
);

/** POST /properties/:id/images (protected — owner only) */
router.post(
  '/:id/images',
  requireAuth,
  requireRole('agent', 'company'),
  enforce((req) => `property-images:${req.authUser.sub}`, 30, 3600, 'Too many image uploads. Please wait before uploading more.'),
  upload.array('images', 15),
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    await authorizeOwnerOrAdmin(req, id);

    const files = req.files || [];
    if (files.length === 0) {
      return response.validationError(res, { images: ['At least one image is required.'] });
    }

    const existingCount = await PropertyImage.countForProperty(id);
    if (existingCount + files.length > 15) {
      return response.validationError(res, { images: ['A property can have at most 15 images.'] });
    }

    const stored = [];
    for (let i = 0; i < files.length; i++) {
      const relativePath = await storeImage(files[i].buffer, 'properties');
      const isPrimary = existingCount === 0 && i === 0;
      await PropertyImage.add(id, relativePath, isPrimary, existingCount + i);
      stored.push(relativePath);
    }

    return response.created(res, stored, 'Images uploaded.');
  })
);

/** PUT /properties/:id (protected — owner only) */
router.put(
  '/:id',
  requireAuth,
  requireRole('agent', 'company'),
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const property = await authorizeOwnerOrAdmin(req, id);

    const allowed = ['title', 'description', 'price', 'bedrooms', 'bathrooms', 'size_sqm', 'address', 'city', 'state', 'latitude', 'longitude'];
    const fields = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) fields[key] = req.body[key];
    }
    if (Object.keys(fields).length === 0) {
      return response.validationError(res, { _: ['No updatable fields provided.'] });
    }

    // Any edit to a previously approved listing by a company-attached
    // agent goes back into that company's own review — an agent
    // shouldn't be able to silently swap in a different price/address
    // after sign-off. (Joan, Sep 2026: admin never re-reviews this —
    // it was never admin's listing to approve in the first place.) A
    // company editing its own listing is self-vetting, same as
    // creating it was, so it stays live with no demotion.
    if (property.status === 'approved' && property.company_id) {
      const lister = await AgentProfile.findByUserId(property.listed_by_user_id);
      if (lister) {
        fields.status = 'pending_company_review';
        fields.approved_by = null;
        fields.approved_at = null;
      }
    }

    await Property.updateFields(id, fields);
    return response.success(res, null, 'Property updated.');
  })
);

/** DELETE /properties/:id (protected — owner or admin) — soft delete */
router.delete(
  '/:id',
  requireAuth,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    await authorizeOwnerOrAdmin(req, id);
    await Property.softDelete(id);
    return response.success(res, null, 'Property removed.');
  })
);

/**
 * POST /properties/:id/company-approve (company only) — the company's
 * own sign-off on one of its agent's listings. This does NOT publish
 * the listing — it only advances it into the normal admin queue
 * ('pending'), same as a listing the company submitted itself. HouseBank
 * admin still has the final say before anything goes public.
 */
router.post(
  '/:id/company-approve',
  requireAuth,
  requireRole('company'),
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const company = await Company.findByUserId(req.authUser.sub);
    if (!company) return response.notFound(res, 'Company profile not found.');

    const property = await Property.findById(id);
    if (!property) return response.notFound(res, 'Property not found.');
    if (property.company_id !== company.id) {
      logger.security('Blocked IDOR attempt on company property approval', {
        property_id: id,
        attempted_by: req.authUser.sub,
      });
      return response.forbidden(res, 'You do not have permission to review this listing.');
    }
    if (property.status !== 'pending_company_review') {
      return response.validationError(res, { status: ['This listing is not awaiting your company\'s review.'] });
    }

    await Property.companyApprove(id, req.authUser.sub);
    await Notification.create(
      property.listed_by_user_id,
      'realtor_listing',
      'Listing approved by your company',
      `${company.company_name} approved "${property.title}" -- it now moves on to HouseBank review before going public.`
    );
    const listerForApproveSms = await User.findById(property.listed_by_user_id);
    await sendSms(
      listerForApproveSms?.phone,
      `HouseBank: ${company.company_name} approved your listing "${property.title}".`
    );
    logger.info('Company approved agent listing', { property_id: id, company_id: company.id, by: req.authUser.sub });
    return response.success(res, null, 'Listing approved — it now moves on to HouseBank review before going public.');
  })
);

/** POST /properties/:id/company-reject (company only) — same authorization as company-approve above. */
router.post(
  '/:id/company-reject',
  requireAuth,
  requireRole('company'),
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const v = new Validator(req.body);
    v.required('reason', 'Reason').max('reason', 255);
    if (v.fails()) return response.validationError(res, v.errors());

    const company = await Company.findByUserId(req.authUser.sub);
    if (!company) return response.notFound(res, 'Company profile not found.');

    const property = await Property.findById(id);
    if (!property) return response.notFound(res, 'Property not found.');
    if (property.company_id !== company.id) {
      logger.security('Blocked IDOR attempt on company property rejection', {
        property_id: id,
        attempted_by: req.authUser.sub,
      });
      return response.forbidden(res, 'You do not have permission to review this listing.');
    }
    if (property.status !== 'pending_company_review') {
      return response.validationError(res, { status: ['This listing is not awaiting your company\'s review.'] });
    }

    await Property.companyReject(id, req.authUser.sub, req.body.reason);
    await Notification.create(
      property.listed_by_user_id,
      'realtor_listing',
      'Listing rejected by your company',
      `${company.company_name} rejected "${property.title}": ${req.body.reason}`
    );
    const listerForRejectSms = await User.findById(property.listed_by_user_id);
    await sendSms(
      listerForRejectSms?.phone,
      `HouseBank: ${company.company_name} rejected your listing "${property.title}": ${req.body.reason}`
    );
    logger.info('Company rejected agent listing', { property_id: id, company_id: company.id, by: req.authUser.sub });
    return response.success(res, null, 'Listing rejected.');
  })
);

/**
 * PATCH /properties/:id/reassign-agent (company only) — hands a
 * property this company owns to a different agent on its own roster
 * (or back to the company itself with agent_user_id: null). Powers
 * both the "assign to a realtor" step after creating a listing and the
 * standalone Transfer Realtor page. Deliberately company-only, not
 * admin: an agent never reassigns another agent's listing, and this
 * never moves a property to an agent outside the caller's own company
 * — that would be a data-integrity hole, not a feature.
 */
router.patch(
  '/:id/reassign-agent',
  requireAuth,
  requireRole('company'),
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const property = await Property.findById(id);
    if (!property) return response.notFound(res, 'Property not found.');

    const company = await Company.findByUserId(req.authUser.sub);
    if (!company || property.company_id !== company.id) {
      logger.security('Blocked IDOR attempt on property reassignment', {
        property_id: id,
        attempted_by: req.authUser.sub,
      });
      return response.forbidden(res, 'You do not have permission to reassign this property.');
    }

    const targetAgentId = req.body.agent_user_id ? Number(req.body.agent_user_id) : null;
    let newListerId = company.user_id;

    if (targetAgentId) {
      const agentProfile = await AgentProfile.findByUserId(targetAgentId);
      if (!agentProfile || agentProfile.company_id !== company.id) {
        return response.validationError(res, {
          agent_user_id: ['That agent is not currently on your roster.'],
        });
      }
      newListerId = targetAgentId;
    }

    await Property.updateFields(id, { listed_by_user_id: newListerId });
    logger.info('Property reassigned', { property_id: id, to_user_id: newListerId, by: req.authUser.sub });
    return response.success(res, null, 'Property reassigned.');
  })
);

/**
 * POST /properties/:id/appeal — Body: { message }. Only the listing's
 * own realtor/company (authorizeOwnerOrAdmin) can appeal, and only
 * while it's actually blocked — appealing a rejected or pending
 * listing doesn't make sense, those have their own review paths.
 * Admin works these off a queue (GET /admin/appeals) the same way it
 * already works pending-listing review, rather than being notified
 * per submission.
 */
router.post(
  '/:id/appeal',
  requireAuth,
  requireRole('agent', 'company'),
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const property = await authorizeOwnerOrAdmin(req, id);

    if (property.status !== 'blocked') {
      return response.validationError(res, { status: ['Only a blocked listing can be appealed.'] });
    }
    if (await PropertyAppeal.hasPending(id)) {
      return response.validationError(res, { status: ['An appeal for this listing is already pending review.'] });
    }

    const v = new Validator(req.body);
    v.required('message').max('message', 2000);
    if (v.fails()) return response.validationError(res, v.errors());

    await PropertyAppeal.create(id, req.authUser.sub, String(req.body.message));
    logger.info('Property appeal submitted', { property_id: id, by: req.authUser.sub });
    return response.success(res, null, 'Appeal submitted — HouseBank will review it and respond here.');
  })
);

/** GET /properties/:id/appeals — the lister's own appeal history for one property. */
router.get(
  '/:id/appeals',
  requireAuth,
  requireRole('agent', 'company'),
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    await authorizeOwnerOrAdmin(req, id);
    const appeals = await PropertyAppeal.findForProperty(id);
    return response.success(res, appeals);
  })
);

module.exports = router;
