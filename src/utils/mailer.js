'use strict';

const { env } = require('../config/env');
const { logger } = require('./logger');

/**
 * Two interchangeable email transports, selected by MAIL_DRIVER in
 * .env ('smtp', the default, or 'brevo'). Every call site still just
 * calls sendMail()/sendOtp() below — neither knows or cares which
 * transport is actually sending.
 *
 * SMTP via nodemailer: on Namecheap cPanel, the simplest setup is to
 * create a mailbox (cPanel → Email Accounts) for your domain and point
 * SMTP_HOST/USER/PASS at it. nodemailer 10 is ESM-only, loaded via
 * dynamic import() and cached (see the matching comment in
 * utils/fileUpload.js for why this project stays CommonJS overall).
 * This version is deliberate, not incidental: nodemailer <=9 carries
 * several disclosed high-severity issues (SMTP command injection via
 * CRLF, SSRF via the raw-message option) that are fixed in 10.
 *
 * Brevo (formerly Sendinblue) via their transactional-email HTTP API:
 * one POST per email, authenticated with an API key over HTTPS —
 * there's no SMTP handshake/login to get wrong, which is exactly the
 * class of problem (`535 Incorrect authentication data`) that's been
 * blocking real signups on the SMTP path. Uses Node's built-in fetch
 * (Node 18+, no new dependency). To switch: set MAIL_DRIVER=brevo and
 * BREVO_API_KEY in .env — SMTP_FROM_EMAIL/SMTP_FROM_NAME are reused as
 * the sender identity for both drivers, so nothing else needs to change.
 */
let transporterPromise = null;

async function getSmtpTransporter() {
  if (transporterPromise) return transporterPromise;

  if (!env.SMTP_HOST) {
    logger.warning('SMTP_HOST not configured — emails will be logged, not sent.');
    return null;
  }

  transporterPromise = import('nodemailer').then(({ default: nodemailer }) =>
    nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    })
  );
  return transporterPromise;
}

async function sendViaSmtp(toEmail, subject, html) {
  const t = await getSmtpTransporter();
  if (!t) {
    logger.info('Email not sent (no SMTP configured) — logging instead', { to: toEmail, subject });
    return false;
  }
  try {
    await t.sendMail({
      from: `"${env.SMTP_FROM_NAME}" <${env.SMTP_FROM_EMAIL}>`,
      to: toEmail,
      subject,
      html,
    });
    return true;
  } catch (err) {
    logger.error('Failed to send email via SMTP', { to: toEmail, error: err.message });
    return false;
  }
}

async function sendViaBrevo(toEmail, subject, html) {
  if (!env.BREVO_API_KEY) {
    logger.warning('BREVO_API_KEY not configured — emails will be logged, not sent.');
    return false;
  }
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': env.BREVO_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { name: env.SMTP_FROM_NAME, email: env.SMTP_FROM_EMAIL },
        to: [{ email: toEmail }],
        subject,
        htmlContent: html,
      }),
    });

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      logger.error('Failed to send email via Brevo', {
        to: toEmail,
        status: res.status,
        body: bodyText.slice(0, 500),
      });
      return false;
    }
    return true;
  } catch (err) {
    logger.error('Failed to send email via Brevo', { to: toEmail, error: err.message });
    return false;
  }
}

async function sendMail(toEmail, subject, html) {
  return env.MAIL_DRIVER === 'brevo' ? sendViaBrevo(toEmail, subject, html) : sendViaSmtp(toEmail, subject, html);
}

async function sendOtp(toEmail, code, purposeLabel) {
  const subject = 'Your HouseBank verification code';
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color:#111;">HouseBank verification code</h2>
      <p>Use the code below to ${purposeLabel}. It expires in 10 minutes.</p>
      <p style="font-size: 32px; font-weight: bold; letter-spacing: 8px; background:#f4f4f4; padding: 16px; text-align:center; border-radius:8px;">${code}</p>
      <p style="color:#666; font-size: 13px;">If you didn't request this, you can safely ignore this email — no one can access your account without this code.</p>
    </div>`;
  const sent = await sendMail(toEmail, subject, html);
  if (!sent) {
    // Safety net: sendMail() already logs *why* it failed (bad creds, host
    // unreachable, TLS/port mismatch — see the "Greeting never received"
    // case this project hit during local setup). Without this, a real
    // delivery failure (SMTP OR Brevo) silently loses the code forever —
    // the account holder has no way to ever receive it, and re-requesting
    // hits the same broken transport again. This does NOT weaken
    // verification: a real, single-use code is still required — it only
    // makes that code recoverable from the server's own log file when
    // delivery itself is broken, which only whoever already has
    // server/log access can read (nobody over the network).
    logger.warning(`OTP email failed to send — code for ${toEmail} (${purposeLabel}): ${code}`);
  }
  return sent;
}

/**
 * Boot-time mail transport check (Joan, Sep 2026 -- "fix the email
 * issues"). The SMTP 535 auth failure documented in
 * claude/backend-status.md was only ever discovered by a real user
 * hitting a real signup and the OTP never arriving -- buried in
 * app.log until someone went looking for it. This runs once at server
 * startup and logs a clear pass/fail up front instead. It does not
 * block the server from starting -- a broken mail transport shouldn't
 * take the whole API down, everything else still works without it.
 */
async function verifyMailTransport() {
  if (env.MAIL_DRIVER === 'brevo') {
    if (!env.BREVO_API_KEY) {
      logger.warning('Mail transport: MAIL_DRIVER=brevo but BREVO_API_KEY is not set -- emails will not send.');
      return;
    }
    try {
      const res = await fetch('https://api.brevo.com/v3/account', {
        headers: { 'api-key': env.BREVO_API_KEY, Accept: 'application/json' },
      });
      if (res.ok) {
        logger.info('Mail transport: Brevo API key verified OK.');
      } else {
        logger.error('Mail transport: Brevo API key rejected at boot -- emails will not send until this is fixed.', {
          status: res.status,
        });
      }
    } catch (err) {
      logger.error('Mail transport: Brevo verification request failed', { error: err.message });
    }
    return;
  }

  const t = await getSmtpTransporter();
  if (!t) {
    logger.warning('Mail transport: SMTP_HOST is not configured -- emails will not send.');
    return;
  }
  try {
    await t.verify();
    logger.info('Mail transport: SMTP connection and login verified OK.');
  } catch (err) {
    logger.error('Mail transport: SMTP verification failed at boot -- emails will not send until this is fixed.', {
      error: err.message,
    });
  }
}

module.exports = { sendMail, sendOtp, verifyMailTransport };
