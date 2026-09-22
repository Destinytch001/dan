'use strict';

const express = require('express');
const { withTransaction } = require('../../config/db');
const { Validator } = require('../../utils/validator');
const response = require('../../utils/response');
const { logger } = require('../../utils/logger');
const { signAccessToken, signPendingTwoFactorToken, verifyPendingTwoFactorToken } = require('../../utils/jwt');
const { enforce, attempt: rateAttempt, reset: rateReset } = require('../../utils/rateLimiter');
const { requireAuth } = require('../../middleware/auth');
const { upload, storeDocument } = require('../../utils/fileUpload');
const bcrypt = require('bcryptjs');
const { sendOtp } = require('../../utils/mailer');
const User = require('../../models/User');
const OtpCode = require('../../models/OtpCode');
const RefreshToken = require('../../models/RefreshToken');
const CustomerProfile = require('../../models/CustomerProfile');
const AgentProfile = require('../../models/AgentProfile');
const CompanyAgentInvite = require('../../models/CompanyAgentInvite');
const Company = require('../../models/Company');
const TwoFactor = require('../../models/TwoFactor');
const Notification = require('../../models/Notification');

const router = express.Router();

/**
 * Wraps an async Express handler so a thrown/rejected error reaches the
 * central error handler instead of crashing the process (Express 4
 * doesn't auto-catch rejected promises in route handlers).
 */
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const byIp = (req) => `signin:${req.ip}`;

async function issueTokens(user, req) {
  const accessToken = signAccessToken({ sub: user.id, role: user.role });
  const refreshToken = await RefreshToken.issue(user.id, req.ip, req.get('user-agent') || 'unknown', 1209600);
  return { accessToken, refreshToken };
}

/**
 * POST /auth/signup
 * multipart/form-data when a file is attached (agent/company), JSON otherwise.
 */
router.post(
  '/signup',
  enforce((req) => `signup:${req.ip}`, 10, 3600, 'Too many signup attempts from this network. Please try again later.'),
  upload.fields([{ name: 'idFile', maxCount: 1 }, { name: 'cacFile', maxCount: 1 }]),
  wrap(async (req, res) => {
    const role = req.body.role;

    const v = new Validator(req.body);
    v.required('email').email('email');
    v.required('phone').phone('phone');
    v.required('password').strongPassword('password');
    v.required('role').in('role', ['customer', 'agent', 'company']);

    if (role === 'customer' || role === 'agent') v.required('fullName', 'Full name');
    if (role === 'company') v.required('companyName').required('companyAddress').required('cacNumber');

    if (v.fails()) return response.validationError(res, v.errors());
    const data = v.validated();

    if (await User.findByEmail(data.email)) {
      return response.validationError(res, { email: ['An account with this email already exists.'] });
    }
    if (await User.findByPhone(data.phone)) {
      return response.validationError(res, { phone: ['An account with this phone number already exists.'] });
    }

    // "Every agent must work for a company" (Joan, Sep 2026) -- there is
    // no more self-service independent-agent signup. A company must
    // have already added this exact email to its roster (see
    // company-agents.routes.js POST /) before the account can be
    // created; the signup below auto-attaches to that company.
    let pendingInvite = null;
    if (role === 'agent') {
      pendingInvite = await CompanyAgentInvite.findPendingByEmail(data.email);
      if (!pendingInvite) {
        return response.validationError(res, {
          email: [
            'No company has invited this email to join as an agent yet. Ask the company to add your email to their roster first, then sign up again with the same email.',
          ],
        });
      }
    }

    const idFile = req.files && req.files.idFile && req.files.idFile[0];
    const cacFile = req.files && req.files.cacFile && req.files.cacFile[0];
    if (role === 'agent' && !idFile) {
      return response.validationError(res, { idFile: ['A valid government-issued ID is required.'] });
    }
    if (role === 'company' && !cacFile) {
      return response.validationError(res, { cacFile: ['A CAC registration certificate is required.'] });
    }

    // Store documents BEFORE opening the transaction (matches the PHP
    // version's reasoning: never leave a half-created user because a
    // file write failed mid-transaction).
    let idDocPath = null;
    let cacDocPath = null;
    if (role === 'agent') idDocPath = await storeDocument(idFile.buffer, 'agent-ids');
    if (role === 'company') cacDocPath = await storeDocument(cacFile.buffer, 'cac-certificates');

    let userId = null;
    try {
      userId = await withTransaction(async (conn) => {
        const id = await User.create(conn, { email: data.email, phone: data.phone, password: data.password, role });

        if (role === 'customer') await CustomerProfile.create(conn, id, data.fullName);
        if (role === 'agent') {
          await AgentProfile.create(conn, id, data.fullName, idDocPath, pendingInvite.company_id);
          await conn.execute(
            `INSERT INTO company_agents (company_id, agent_id, status, joined_at) VALUES (?, ?, 'active', NOW())`,
            [pendingInvite.company_id, id]
          );
          await CompanyAgentInvite.accept(conn, pendingInvite.id, id);
        }
        if (role === 'company') await Company.create(conn, id, data.companyName, data.companyAddress, data.cacNumber, cacDocPath);

        return id;
      });

      if (role === 'agent') {
        // Best-effort tidy-up, not correctness-critical -- the invite that
        // actually mattered was already accepted above.
        await CompanyAgentInvite.expireOtherPendingForEmail(data.email, pendingInvite.id);
      }

      const otp = await OtpCode.generateAndStore(userId, 'signup_verification');
      const sent = await sendOtp(data.email, otp, 'verify your HouseBank account');
      if (!sent) {
        throw new Error('Verification email delivery failed.');
      }

      logger.security('New signup', { user_id: userId, role, ip: req.ip, company_id: role === 'agent' ? pendingInvite.company_id : undefined });

      return response.created(res, { user_id: userId, email: data.email }, 'Account created. Please check your email for a verification code.');
    } catch (err) {
      if (userId) {
        try {
          await User.deleteById(userId);
        } catch (cleanupErr) {
          logger.error('Failed to roll back partial signup user record', {
            userId,
            email: data.email,
            cleanupError: cleanupErr.message,
          });
        }
      }
      logger.error('Signup failed and user record was rolled back', {
        userId,
        email: data.email,
        role,
        error: err && err.message ? err.message : String(err),
      });
      return response.serverError(res, 'We could not complete your signup because the verification email could not be sent. Please try again.');
    }
  })
);

/** POST /auth/verify-otp — Body: { userId, code } */
router.post(
  '/verify-otp',
  enforce((req) => `otp-verify-ip:${req.ip}`, 30, 3600, 'Too many attempts from this network. Please try again later.'),
  wrap(async (req, res) => {
    const v = new Validator(req.body);
    v.required('userId').integer('userId');
    v.required('code').regex('code', /^\d{6}$/, 'Code must be 6 digits.');
    if (v.fails()) return response.validationError(res, v.errors());

    const userId = Number(req.body.userId);
    const allowed = await rateAttempt(`otp-verify:${userId}`, 10, 600);
    if (!allowed) return response.tooManyRequests(res, 'Too many attempts. Please request a new code.');

    const user = await User.findById(userId);
    if (!user) return response.notFound(res, 'Account not found.');

    if (!(await OtpCode.verify(userId, 'signup_verification', String(req.body.code)))) {
      return response.validationError(res, { code: ['Invalid or expired code.'] });
    }

    await User.markEmailVerified(userId);
    const refreshedUser = await User.findById(userId);
    const { accessToken, refreshToken } = await issueTokens(refreshedUser, req);
    const displayName = await User.getDisplayName(refreshedUser);

    return response.success(res, { token: accessToken, refreshToken, user: User.toPublicObject(refreshedUser, displayName) }, 'Account verified successfully.');
  })
);

/** POST /auth/resend-otp — Body: { userId, purpose } */
router.post(
  '/resend-otp',
  enforce((req) => `otp-resend-ip:${req.ip}`, 20, 3600, 'Too many code requests from this network. Please try again later.'),
  wrap(async (req, res) => {
    const v = new Validator(req.body);
    v.required('userId').integer('userId');
    v.required('purpose').in('purpose', ['signup_verification', 'password_reset']);
    if (v.fails()) return response.validationError(res, v.errors());

    const userId = Number(req.body.userId);
    const allowed = await rateAttempt(`otp-resend:${userId}`, 3, 300);
    if (!allowed) return response.tooManyRequests(res, 'Please wait a few minutes before requesting another code.');

    const user = await User.findById(userId);
    if (!user) return response.success(res, null, 'If the account exists, a new code has been sent.');

    const otp = await OtpCode.generateAndStore(userId, req.body.purpose);
    await sendOtp(user.email, otp, 'verify your HouseBank account');

    return response.success(res, null, 'If the account exists, a new code has been sent.');
  })
);

/** POST /auth/signin — Body: { userName, password }. `userName` accepts an email or phone. */
router.post(
  '/signin',
  enforce(byIp, 15, 900, 'Too many sign-in attempts from this network. Please try again later.'),
  wrap(async (req, res) => {
    const v = new Validator(req.body);
    v.required('userName').required('password');
    if (v.fails()) return response.validationError(res, v.errors());

    const user = await User.findByIdentifier(String(req.body.userName));

    if (!user) {
      await new Promise((r) => setTimeout(r, 100 + Math.random() * 150));
      logger.security('Failed login: unknown identifier', { ip: req.ip });
      return response.unauthorized(res, 'Invalid credentials.');
    }

    if (User.isLocked(user)) {
      logger.security('Login blocked: account locked', { user_id: user.id });
      return response.error(res, 'This account is temporarily locked due to repeated failed attempts. Please try again later or reset your password.', 423);
    }

    if (user.status === 'suspended' || user.status === 'banned') {
      return response.forbidden(res, `This account has been ${user.status}. Contact support for help.`);
    }

    const valid = await bcrypt.compare(String(req.body.password), user.password_hash);
    if (!valid) {
      await User.registerFailedLogin(user.id);
      const allowed = await rateAttempt(`signin-user:${user.id}`, 8, 900);
      if (!allowed) return response.tooManyRequests(res, 'Too many failed attempts on this account.');
      logger.security('Failed login: wrong password', { user_id: user.id, ip: req.ip });
      return response.unauthorized(res, 'Invalid credentials.');
    }

    if (user.status === 'pending_verification') {
      return response.error(res, 'Please verify your account with the code sent to your email before signing in.', 403, {
        requires_verification: true,
        user_id: user.id,
      });
    }

    // Password is correct at this point. If 2FA is enabled, stop here —
    // no access token yet — and email a fresh login code, the same
    // OtpCode/mailer path signup verification and password reset already
    // run through. The pending token proves "this caller just proved
    // they know the password" without granting API access — only
    // /auth/2fa/verify-login accepts it, and only alongside a valid code.
    const twoFactorEnabled = await TwoFactor.isEnabled(user.id);
    if (twoFactorEnabled) {
      const otp = await OtpCode.generateAndStore(user.id, 'login_2fa');
      await sendOtp(user.email, otp, 'sign in to your HouseBank account');
      const pendingToken = signPendingTwoFactorToken({ sub: user.id });
      logger.security('Password verified, 2FA code emailed', { user_id: user.id, ip: req.ip });
      return response.success(
        res,
        { requires_2fa: true, pending_token: pendingToken },
        'Enter the code we emailed you to finish signing in.'
      );
    }

    await User.recordSuccessfulLogin(user.id, req.ip);
    await rateReset(`signin-user:${user.id}`);

    const { accessToken, refreshToken } = await issueTokens(user, req);
    logger.security('Successful login', { user_id: user.id, ip: req.ip });
    const displayName = await User.getDisplayName(user);

    return response.success(res, { token: accessToken, refreshToken, user: User.toPublicObject(user, displayName) }, 'Signed in successfully.');
  })
);

/**
 * POST /auth/2fa/verify-login (public) — the second half of signing in
 * on a 2FA-enabled account. Body: { pending_token, code }. `code` may
 * be the emailed 6-digit code or a recovery code.
 */
router.post(
  '/2fa/verify-login',
  enforce((req) => `2fa-verify-ip:${req.ip}`, 20, 900, 'Too many attempts from this network. Please try again later.'),
  wrap(async (req, res) => {
    const v = new Validator(req.body);
    v.required('pending_token');
    v.required('code');
    if (v.fails()) return response.validationError(res, v.errors());

    const payload = verifyPendingTwoFactorToken(String(req.body.pending_token));
    if (!payload) {
      return response.unauthorized(res, 'Your sign-in session expired. Please sign in again.');
    }

    const userId = payload.sub;
    const allowed = await rateAttempt(`2fa-verify-user:${userId}`, 8, 900);
    if (!allowed) {
      logger.security('2FA verify rate-limited', { user_id: userId, ip: req.ip });
      return response.tooManyRequests(res, 'Too many attempts. Please sign in again.');
    }

    const user = await User.findById(userId);
    if (!user) return response.unauthorized(res, 'Account not found.');

    const twoFactorEnabled = await TwoFactor.isEnabled(userId);
    if (!twoFactorEnabled) {
      return response.unauthorized(res, 'Two-factor authentication is not enabled on this account.');
    }

    const submitted = String(req.body.code).trim();
    let usedRecoveryCode = false;
    let ok = await OtpCode.verify(userId, 'login_2fa', submitted);
    if (!ok) {
      ok = await TwoFactor.consumeRecoveryCode(userId, submitted);
      usedRecoveryCode = ok;
    }

    if (!ok) {
      logger.security('Failed 2FA verification', { user_id: userId, ip: req.ip });
      return response.validationError(res, { code: ['Invalid or expired code.'] });
    }

    await User.recordSuccessfulLogin(userId, req.ip);
    await rateReset(`signin-user:${userId}`);
    await rateReset(`2fa-verify-user:${userId}`);

    const { accessToken, refreshToken } = await issueTokens(user, req);
    const displayName = await User.getDisplayName(user);
    logger.security(usedRecoveryCode ? 'Successful login via 2FA recovery code' : 'Successful login via 2FA', {
      user_id: userId,
      ip: req.ip,
    });

    if (usedRecoveryCode) {
      const remaining = await TwoFactor.remainingRecoveryCodeCount(userId);
      await Notification.create(
        userId,
        'security',
        'Recovery code used',
        `A recovery code was used to sign in to your account. ${remaining} recovery code${remaining === 1 ? '' : 's'} remaining.`
      );
    }

    return response.success(
      res,
      { token: accessToken, refreshToken, user: User.toPublicObject(user, displayName), used_recovery_code: usedRecoveryCode },
      'Signed in successfully.'
    );
  })
);

/**
 * POST /auth/2fa/request-code (protected) — Body: { current_password }.
 * Emails a fresh login_2fa code and returns a generic success message.
 * Used both to start ENABLING 2FA and to authorize DISABLING it — both
 * directions need the same proof: the current password, plus access to
 * the account's email. Requiring the password (not just an active
 * session) means a hijacked session can't silently toggle 2FA on or off
 * without the real owner noticing.
 */
router.post(
  '/2fa/request-code',
  requireAuth,
  enforce((req) => `2fa-request:${req.authUser.sub}`, 5, 900, 'Too many code requests. Please wait a few minutes.'),
  wrap(async (req, res) => {
    const v = new Validator(req.body);
    v.required('current_password');
    if (v.fails()) return response.validationError(res, v.errors());

    const user = await User.findById(req.authUser.sub);
    if (!user) return response.notFound(res, 'Account not found.');

    const valid = await bcrypt.compare(String(req.body.current_password), user.password_hash);
    if (!valid) {
      logger.security('2FA code request rejected: wrong password', { user_id: user.id });
      return response.validationError(res, { current_password: ['Incorrect password.'] });
    }

    const otp = await OtpCode.generateAndStore(user.id, 'login_2fa');
    await sendOtp(user.email, otp, 'confirm a change to two-factor authentication on your HouseBank account');

    return response.success(res, null, 'A code has been sent to your email.');
  })
);

/**
 * POST /auth/2fa/confirm (protected) — Body: { code }. Enables 2FA and
 * returns one-time recovery codes. Call /2fa/request-code first.
 */
router.post(
  '/2fa/confirm',
  requireAuth,
  wrap(async (req, res) => {
    const v = new Validator(req.body);
    v.required('code');
    if (v.fails()) return response.validationError(res, v.errors());

    const alreadyEnabled = await TwoFactor.isEnabled(req.authUser.sub);
    if (alreadyEnabled) {
      return response.validationError(res, { code: ['Two-factor authentication is already enabled.'] });
    }

    if (!(await OtpCode.verify(req.authUser.sub, 'login_2fa', String(req.body.code)))) {
      return response.validationError(res, { code: ['Invalid or expired code.'] });
    }

    const recoveryCodes = await TwoFactor.enable(req.authUser.sub);
    logger.security('2FA enabled', { user_id: req.authUser.sub });
    await Notification.create(
      req.authUser.sub,
      'security',
      'Two-factor authentication enabled',
      'A code emailed to you is now required to sign in to your account.'
    );

    return response.success(res, { recovery_codes: recoveryCodes }, 'Two-factor authentication enabled.');
  })
);

/**
 * POST /auth/2fa/disable (protected) — Body: { code }. Requires a
 * current emailed code or a recovery code — call /2fa/request-code
 * first — so disabling 2FA proves possession of the second factor
 * being removed, not just an active session.
 */
router.post(
  '/2fa/disable',
  requireAuth,
  wrap(async (req, res) => {
    const v = new Validator(req.body);
    v.required('code');
    if (v.fails()) return response.validationError(res, v.errors());

    const enabled = await TwoFactor.isEnabled(req.authUser.sub);
    if (!enabled) {
      return response.validationError(res, { code: ['Two-factor authentication is not enabled.'] });
    }

    const submitted = String(req.body.code).trim();
    let ok = await OtpCode.verify(req.authUser.sub, 'login_2fa', submitted);
    if (!ok) ok = await TwoFactor.consumeRecoveryCode(req.authUser.sub, submitted);
    if (!ok) {
      logger.security('2FA disable rejected: invalid code', { user_id: req.authUser.sub });
      return response.validationError(res, { code: ['Invalid or expired code.'] });
    }

    await TwoFactor.disable(req.authUser.sub);
    logger.security('2FA disabled', { user_id: req.authUser.sub });
    await Notification.create(
      req.authUser.sub,
      'security',
      'Two-factor authentication disabled',
      'Two-factor authentication has been turned off for your account.'
    );

    return response.success(res, null, 'Two-factor authentication disabled.');
  })
);

/** POST /auth/refresh — Body: { refreshToken } */
router.post(
  '/refresh',
  wrap(async (req, res) => {
    const token = String(req.body.refreshToken || '');
    if (!token) return response.unauthorized(res, 'Refresh token required.');

    const userId = await RefreshToken.validate(token);
    if (!userId) {
      logger.security('Rejected invalid refresh token', { ip: req.ip });
      return response.unauthorized(res, 'Session expired. Please sign in again.');
    }

    const user = await User.findById(userId);
    if (!user || ['suspended', 'banned'].includes(user.status)) {
      return response.unauthorized(res, 'Session no longer valid.');
    }

    // Rotate: revoke the used refresh token and issue a fresh pair —
    // limits a stolen refresh token to a single use.
    await RefreshToken.revoke(token);
    const { accessToken, refreshToken } = await issueTokens(user, req);

    return response.success(res, { token: accessToken, refreshToken }, 'Token refreshed.');
  })
);

/** POST /auth/logout (protected) — revokes all refresh tokens for the user. */
router.post(
  '/logout',
  requireAuth,
  wrap(async (req, res) => {
    await RefreshToken.revokeAllForUser(req.authUser.sub);
    logger.security('Logout', { user_id: req.authUser.sub });
    return response.success(res, null, 'Logged out.');
  })
);

/** GET /auth/me (protected) */
router.get(
  '/me',
  requireAuth,
  wrap(async (req, res) => {
    const user = await User.findById(req.authUser.sub);
    if (!user) return response.notFound(res, 'User not found.');
    const displayName = await User.getDisplayName(user);
    return response.success(res, User.toPublicObject(user, displayName));
  })
);

/**
 * POST /auth/change-password (protected — any role). Body:
 * { current_password, new_password }. Joan, Sep 2026: "the admin
 * should be able to reset their own password" — there was no
 * authenticated change-password endpoint anywhere for ANY role; the
 * only thing that existed was the unauthenticated forgot-password/OTP
 * flow, which requires giving up account access first. Same proof
 * requirement as toggling 2FA (current password), same "revoke every
 * other session" posture as a forgot-password reset — except this
 * request's own session gets a fresh token pair instead of being
 * logged out, since it just proved who it is.
 */
router.post(
  '/change-password',
  requireAuth,
  enforce((req) => `change-password:${req.authUser.sub}`, 5, 900, 'Too many attempts. Please wait before trying again.'),
  wrap(async (req, res) => {
    const v = new Validator(req.body);
    v.required('current_password');
    v.required('new_password').strongPassword('new_password');
    if (v.fails()) return response.validationError(res, v.errors());

    const user = await User.findById(req.authUser.sub);
    if (!user) return response.notFound(res, 'Account not found.');

    const valid = await bcrypt.compare(String(req.body.current_password), user.password_hash);
    if (!valid) {
      logger.security('Change-password rejected: wrong current password', { user_id: user.id });
      return response.validationError(res, { current_password: ['Incorrect password.'] });
    }

    await User.updatePasswordHash(user.id, String(req.body.new_password));
    await RefreshToken.revokeAllForUser(user.id);
    const { accessToken, refreshToken } = await issueTokens(user, req);

    logger.security('Password changed', { user_id: user.id });
    await Notification.create(
      user.id,
      'security',
      'Password changed',
      "Your HouseBank password was just changed. If this wasn't you, contact support immediately."
    );

    return response.success(res, { token: accessToken, refreshToken }, 'Password changed.');
  })
);

/** POST /auth/forgot-password — Body: { email }. Always generic — no account enumeration. */
router.post(
  '/forgot-password',
  enforce((req) => `forgot-password:${req.ip}`, 5, 900),
  wrap(async (req, res) => {
    const v = new Validator(req.body);
    v.required('email').email('email');
    if (v.fails()) return response.validationError(res, v.errors());

    const user = await User.findByEmail(String(req.body.email));
    if (user) {
      const otp = await OtpCode.generateAndStore(user.id, 'password_reset');
      await sendOtp(user.email, otp, 'reset your HouseBank password');
    }

    return response.success(res, null, 'If that email is registered, a reset code has been sent.');
  })
);

/** POST /auth/reset-password — Body: { email, code, newPassword } */
router.post(
  '/reset-password',
  wrap(async (req, res) => {
    const v = new Validator(req.body);
    v.required('email').email('email');
    v.required('code').regex('code', /^\d{6}$/, 'Code must be 6 digits.');
    v.required('newPassword').strongPassword('newPassword');
    if (v.fails()) return response.validationError(res, v.errors());

    const user = await User.findByEmail(String(req.body.email));
    if (!user) return response.validationError(res, { code: ['Invalid or expired code.'] });

    if (!(await OtpCode.verify(user.id, 'password_reset', String(req.body.code)))) {
      return response.validationError(res, { code: ['Invalid or expired code.'] });
    }

    await User.updatePasswordHash(user.id, String(req.body.newPassword));
    await RefreshToken.revokeAllForUser(user.id); // force re-login everywhere

    logger.security('Password reset', { user_id: user.id });

    return response.success(res, null, 'Password reset successfully. Please sign in with your new password.');
  })
);

module.exports = router;
