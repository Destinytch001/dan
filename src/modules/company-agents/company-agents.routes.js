'use strict';

const express = require('express');
const { Validator } = require('../../utils/validator');
const response = require('../../utils/response');
const { logger } = require('../../utils/logger');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { enforce } = require('../../utils/rateLimiter');
const Company = require('../../models/Company');
const CompanyAgent = require('../../models/CompanyAgent');
const CompanyAgentInvite = require('../../models/CompanyAgentInvite');
const Notification = require('../../models/Notification');
const { sendMail } = require('../../utils/mailer');
const { env } = require('../../config/env');

const router = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

/**
 * The company-agents module: a company's realtor roster, and now the
 * only door into becoming an agent at all — see auth.routes.js's signup
 * gate. "Every agent must work for a company" (Joan, Sep 2026) closed
 * off self-service independent-agent signup; a company invites by email
 * instead, and the agent onboards themselves through the normal signup
 * form using that same email. Two shapes are handled by the same
 * POST / below:
 *  - the email already belongs to an independent agent account (the
 *    pre-rule-change case, or an agent who left another company) →
 *    attach immediately, same as before this tranche;
 *  - no account exists yet with that email → record a pending invite;
 *    POST /auth/signup checks for it and auto-attaches on signup.
 *
 * See CompanyAgent.js for the reasoning behind "staff-initiated,
 * consent-free attach" on the first case, and CompanyAgentInvite.js for
 * the invite lifecycle on the second.
 *
 * Every route here is requireRole('company') only — an agent doesn't
 * manage their own company_id (see AgentProfile.js's UPDATABLE_FIELDS
 * comment), so there's no agent-facing endpoint in this module.
 */
async function requireCompany(req) {
  const company = await Company.findByUserId(req.authUser.sub);
  if (!company) {
    const err = new Error('Company profile not found.');
    err.status = 404;
    throw err;
  }
  return company;
}

/** GET /company-agents/mine */
router.get(
  '/mine',
  requireAuth,
  requireRole('company'),
  wrap(async (req, res) => {
    const company = await requireCompany(req);
    const roster = await CompanyAgent.listRoster(company.id);
    return response.success(res, roster);
  })
);

/** GET /company-agents/ranking */
router.get(
  '/ranking',
  requireAuth,
  requireRole('company'),
  wrap(async (req, res) => {
    const company = await requireCompany(req);
    const ranked = await CompanyAgent.ranking(company.id);
    return response.success(res, ranked);
  })
);

/** GET /company-agents/invites — this company's own pending invites. */
router.get(
  '/invites',
  requireAuth,
  requireRole('company'),
  wrap(async (req, res) => {
    const company = await requireCompany(req);
    const invites = await CompanyAgentInvite.listPendingForCompany(company.id);
    return response.success(res, invites);
  })
);

/**
 * GET /company-agents/invites/:token (PUBLIC — deliberately no
 * requireAuth/requireRole) — the only door into the realtor onboarding
 * page (frontend route /realtor-onboarding/:token). The person opening
 * this link doesn't have a HouseBank account yet, so this can't be
 * gated behind auth the way every other route in this file is. It
 * exposes only what the onboarding page needs to show (the inviting
 * company's name, and the invited email so the signup form can lock
 * that field) — never the company's id list, roster, or anything else.
 * An unknown, already-accepted, revoked, or expired token all return
 * the same 404 rather than leaking which case it was.
 */
router.get(
  '/invites/:token',
  wrap(async (req, res) => {
    const invite = await CompanyAgentInvite.findPendingByToken(req.params.token);
    if (!invite) {
      return response.notFound(res, 'This invitation link is invalid or has expired.');
    }
    return response.success(res, { email: invite.email, company_name: invite.company_name });
  })
);

/**
 * POST /company-agents — body { email } — add an agent to the roster by
 * email, whether or not they have an account yet. Rate-limited per
 * company: this both attaches an existing account and, on the invite
 * path, sets an expectation the invited person will act on ("go sign
 * up"), so it gets the same abuse guardrail every other account-
 * affecting endpoint in this backend has.
 */
router.post(
  '/',
  requireAuth,
  requireRole('company'),
  enforce((req) => `company-invite:${req.authUser.sub}`, 30, 3600, 'Too many roster invites. Please wait before adding more.'),
  wrap(async (req, res) => {
    const v = new Validator(req.body);
    v.required('email').email('email');
    if (v.fails()) return response.validationError(res, v.errors());
    const email = String(req.body.email).trim().toLowerCase();

    const company = await requireCompany(req);
    const candidate = await CompanyAgent.findAttachableAgentByEmail(email);

    if (candidate) {
      if (candidate.role !== 'agent') {
        return response.validationError(res, {
          email: ['That email belongs to an existing account that is not an agent.'],
        });
      }
      if (candidate.company_id) {
        return response.validationError(res, {
          email: ['That agent is already attached to a company.'],
        });
      }

      await CompanyAgent.attach(company.id, candidate.user_id);
      await Notification.create(
        candidate.user_id,
        'realtor_company',
        'Added to a company roster',
        `You've been added to ${company.company_name}'s realtor roster on HouseBank.`
      );
      logger.info('Agent attached to company roster', { company_id: company.id, agent_user_id: candidate.user_id });

      return response.created(res, null, `${candidate.full_name || 'Agent'} has been added to your roster.`);
    }

    // No account with this email yet — record an invite instead.
    const existingInvite = await CompanyAgentInvite.findPendingForCompanyAndEmail(company.id, email);
    if (existingInvite) {
      return response.success(res, null, `${email} has already been invited — waiting for them to sign up.`);
    }

    const invite = await CompanyAgentInvite.create(null, company.id, email, req.authUser.sub);

    // The actual onboarding link (Joan, Sep 2026: "once they are invited,
    // they should get an onboarding link to their own signup page, that
    // will also show the company they are signing up with in details").
    // FRONTEND_URL has no trailing slash (see config/env.js), so this is
    // always a clean, single-slash join.
    const onboardingLink = `${env.FRONTEND_URL}/realtor-onboarding/${invite.token}`;
    const emailSent = await sendMail(
      email,
      `You've been invited to join ${company.company_name} on HouseBank`,
      `
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
          <h2 style="color:#111;">You're invited to join ${company.company_name}</h2>
          <p>${company.company_name} has invited you to join HouseBank as one of their realtors.</p>
          <p>
            <a href="${onboardingLink}"
               style="display:inline-block; background:#15803d; color:#fff; padding:12px 24px;
                      border-radius:8px; text-decoration:none; font-weight:bold;">
              Complete your registration
            </a>
          </p>
          <p style="color:#666; font-size: 13px;">
            If the button above doesn't work, copy and paste this link into your browser:<br />
            ${onboardingLink}
          </p>
          <p style="color:#666; font-size: 13px;">
            If you weren't expecting this, you can safely ignore this email.
          </p>
        </div>`
    );
    if (!emailSent) {
      // Same degrade-gracefully pattern as OTP mail (see utils/mailer.js):
      // the invite row itself always exists and the token-based link keeps
      // working regardless of whether this particular email made it out,
      // so a delivery failure here shouldn't fail the whole request -- it
      // just means the company needs to pass the link on some other way
      // until mail delivery is fixed.
      logger.warning('Realtor invite email failed to send', { company_id: company.id, email });
    }

    logger.info('Agent invite created', { company_id: company.id, email });

    return response.created(
      res,
      null,
      `Invite sent — ${email} will get an email with a link to complete their registration with ${company.company_name}.`
    );
  })
);

/** POST /company-agents/invites/:id/revoke */
router.post(
  '/invites/:id/revoke',
  requireAuth,
  requireRole('company'),
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const company = await requireCompany(req);

    const revoked = await CompanyAgentInvite.revoke(id, company.id);
    if (!revoked) {
      logger.security('Blocked attempt to revoke a non-owned or non-pending invite', {
        company_id: company.id,
        attempted_invite_id: id,
        by: req.authUser.sub,
      });
      return response.notFound(res, 'That invite was not found.');
    }

    return response.success(res, null, 'Invite revoked.');
  })
);

/** POST /company-agents/:agentUserId/remove */
router.post(
  '/:agentUserId/remove',
  requireAuth,
  requireRole('company'),
  wrap(async (req, res) => {
    const agentUserId = Number(req.params.agentUserId);
    const company = await requireCompany(req);

    const isMember = await CompanyAgent.isActiveMember(company.id, agentUserId);
    if (!isMember) {
      logger.security('Blocked attempt to remove a non-roster agent', {
        company_id: company.id,
        attempted_agent_user_id: agentUserId,
        by: req.authUser.sub,
      });
      return response.notFound(res, 'That agent is not currently on your roster.');
    }

    await CompanyAgent.remove(company.id, agentUserId);
    logger.info('Agent removed from company roster', { company_id: company.id, agent_user_id: agentUserId });

    return response.success(res, null, 'Agent removed from your roster.');
  })
);

module.exports = router;
