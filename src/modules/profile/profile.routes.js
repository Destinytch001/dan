'use strict';

const express = require('express');
const { Validator } = require('../../utils/validator');
const response = require('../../utils/response');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { upload, storeImage } = require('../../utils/fileUpload');
const User = require('../../models/User');
const CustomerProfile = require('../../models/CustomerProfile');
const AgentProfile = require('../../models/AgentProfile');
const Company = require('../../models/Company');

const router = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

/**
 * One profile endpoint set shared by every role, rather than separate
 * customer/agent/company profile modules — the shape of "profile" is
 * different per role (a customer has an address, an agent has a company
 * they work for, a company has CAC verification), but the fetch/update/
 * upload-avatar operations on it are identical, so the branching lives
 * here instead of being duplicated three times.
 */

/** GET /profile/me (protected — any role) */
router.get(
  '/me',
  requireAuth,
  wrap(async (req, res) => {
    const user = await User.findById(req.authUser.sub);
    if (!user) return response.notFound(res, 'User not found.');

    let profile = null;

    if (user.role === 'customer') {
      const p = await CustomerProfile.findByUserId(user.id);
      profile = p && {
        full_name: p.full_name,
        avatar_path: p.avatar_path,
        address: p.address,
        city: p.city,
        state: p.state,
        date_of_birth: p.date_of_birth,
      };
    } else if (user.role === 'agent') {
      const p = await AgentProfile.findByUserIdWithCompany(user.id);
      profile = p && {
        full_name: p.full_name,
        avatar_path: p.avatar_path,
        bio: p.bio,
        verification_status: p.verification_status,
        // Null when the agent isn't currently attached to any company —
        // an independent agent is a normal, valid state, not an error.
        company: p.company_id
          ? {
              id: p.company_id,
              name: p.company_name,
              logo_path: p.company_logo_path,
              verification_status: p.company_verification_status,
            }
          : null,
      };
    } else if (user.role === 'company') {
      const c = await Company.findByUserId(user.id);
      profile = c && {
        company_name: c.company_name,
        company_address: c.company_address,
        logo_path: c.logo_path,
        verification_status: c.verification_status,
      };
    } else if (user.role === 'admin') {
      // No admin_profiles table (migration 014) — the account fields
      // below plus this one column are all there is to show.
      profile = { avatar_path: user.avatar_path };
    }

    return response.success(res, {
      id: user.id,
      email: user.email,
      phone: user.phone,
      role: user.role,
      status: user.status,
      email_verified: user.email_verified_at !== null,
      profile,
    });
  })
);

/**
 * PUT /profile/me (protected) — role-aware partial update.
 * Deliberately NOT available to company or admin here: a company's
 * company_name/cac_number are identity-verification facts (changing
 * them should go through re-verification, not a quiet profile edit),
 * and admin has no profile table to update.
 */
router.put(
  '/me',
  requireAuth,
  wrap(async (req, res) => {
    const userId = req.authUser.sub;
    const role = req.authUser.role;

    if (role === 'customer') {
      const v = new Validator(req.body);
      if (req.body.full_name !== undefined) v.max('full_name', 150);
      if (req.body.address !== undefined) v.max('address', 255);
      if (req.body.city !== undefined) v.max('city', 100);
      if (req.body.state !== undefined) v.max('state', 100);
      if (req.body.date_of_birth) {
        v.regex('date_of_birth', /^\d{4}-\d{2}-\d{2}$/, 'Date of birth must be in YYYY-MM-DD format.');
      }
      if (v.fails()) return response.validationError(res, v.errors());

      const fields = {};
      for (const key of CustomerProfile.UPDATABLE_FIELDS) {
        if (req.body[key] !== undefined) fields[key] = req.body[key] === '' ? null : req.body[key];
      }
      if (Object.keys(fields).length === 0) {
        return response.validationError(res, { _: ['No updatable fields provided.'] });
      }
      await CustomerProfile.updateFields(userId, fields);
      return response.success(res, null, 'Profile updated.');
    }

    if (role === 'agent') {
      const v = new Validator(req.body);
      if (req.body.full_name !== undefined) v.max('full_name', 150);
      if (req.body.bio !== undefined) v.max('bio', 2000);
      if (v.fails()) return response.validationError(res, v.errors());

      const fields = {};
      for (const key of AgentProfile.UPDATABLE_FIELDS) {
        if (req.body[key] !== undefined) fields[key] = req.body[key] === '' ? null : req.body[key];
      }
      if (Object.keys(fields).length === 0) {
        return response.validationError(res, { _: ['No updatable fields provided.'] });
      }
      await AgentProfile.updateFields(userId, fields);
      return response.success(res, null, 'Profile updated.');
    }

    return response.forbidden(res, 'This role has no editable profile fields.');
  })
);

/**
 * POST /profile/me/avatar (protected — customer, agent, company, admin).
 * Admin support added by migration 014 (Joan, Sep 2026: "admin should
 * also be able to edit their profile image too"), storing directly on
 * users.avatar_path since admin has no profile table of its own.
 */
router.post(
  '/me/avatar',
  requireAuth,
  requireRole('customer', 'agent', 'company', 'admin'),
  upload.single('avatar'),
  wrap(async (req, res) => {
    if (!req.file) {
      return response.validationError(res, { avatar: ['An image file is required.'] });
    }

    const relativePath = await storeImage(req.file.buffer, 'avatars');
    const userId = req.authUser.sub;

    if (req.authUser.role === 'customer') {
      await CustomerProfile.updateAvatar(userId, relativePath);
    } else if (req.authUser.role === 'agent') {
      await AgentProfile.updateAvatar(userId, relativePath);
    } else if (req.authUser.role === 'company') {
      await Company.updateLogo(userId, relativePath);
    } else {
      await User.updateAvatar(userId, relativePath);
    }

    return response.success(res, { avatar_path: relativePath }, 'Profile picture updated.');
  })
);

module.exports = router;
