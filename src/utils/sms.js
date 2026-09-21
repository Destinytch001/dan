'use strict';

const { env } = require('../config/env');
const { logger } = require('./logger');

/**
 * SMS via Twilio's REST API -- one POST per message, HTTP Basic Auth
 * (Account SID : Auth Token), form-encoded body. No `twilio` npm package
 * needed: Node's built-in fetch is enough, the same shape as the Brevo
 * email driver in mailer.js.
 *
 * Scope (Joan, Sep 2026: "sms notification is on payments, bookings and
 * approvals only"): wired into the CONFIRMED/decided event in each of
 * those three flows -- a purchase/rental/investment being confirmed
 * (payment), a viewing being confirmed (booking), and a company/listing
 * approval or rejection decision (approvals) -- not every intermediate
 * notification the app already creates, so this doesn't multiply into a
 * text for every status change.
 *
 * Optional by design: if TWILIO_SID/TWILIO_AUTH_TOKEN/TWILIO_FROM aren't
 * set in .env, or the recipient has no phone on file, this silently
 * no-ops (logged, not thrown) -- SMS is a notification channel, never a
 * dependency the underlying action (the payment, the booking, the
 * approval) should fail over.
 */
async function sendSms(toPhone, body) {
  if (!toPhone) {
    logger.info('SMS not sent — recipient has no phone on file.');
    return false;
  }
  if (!env.TWILIO_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM) {
    logger.warning('Twilio not configured (TWILIO_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM) — SMS not sent.', {
      to: toPhone,
    });
    return false;
  }

  try {
    const auth = Buffer.from(`${env.TWILIO_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64');
    const params = new URLSearchParams({ To: toPhone, From: env.TWILIO_FROM, Body: body });

    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      logger.error('Failed to send SMS via Twilio', { to: toPhone, status: res.status, body: bodyText.slice(0, 500) });
      return false;
    }
    return true;
  } catch (err) {
    logger.error('Failed to send SMS via Twilio', { to: toPhone, error: err.message });
    return false;
  }
}

module.exports = { sendSms };
