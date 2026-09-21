'use strict';

const express = require('express');
const { Validator } = require('../../utils/validator');
const response = require('../../utils/response');
const { logger } = require('../../utils/logger');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { enforce } = require('../../utils/rateLimiter');
const User = require('../../models/User');
const Conversation = require('../../models/Conversation');
const Contact = require('../../models/Contact');
const Notification = require('../../models/Notification');
const { resolveCallerCompanyId } = require('../../utils/companyScope');

const router = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

/**
 * Who a customer is allowed to message: only an agent, or the company
 * that agent works for — never the platform admin, and never a cold
 * message to a stranger agent they've had no real dealings with. This
 * re-uses Contact.forCustomer, the exact same list "my realtor"
 * (GET /contacts/mine) is built from, so the two stay in lockstep.
 */
async function assertCustomerCanMessage(customerUserId, targetUserId) {
  const contacts = await Contact.forCustomer(customerUserId);
  return contacts.some((c) => Number(c.user_id) === Number(targetUserId));
}

/**
 * The agent/company mirror of assertCustomerCanMessage above — was
 * referenced below but never actually defined anywhere in this file,
 * which meant every agent/company attempt to start a new conversation
 * (POST / with role agent/company) threw a ReferenceError at runtime.
 * Boot testing (node -c + a clean server start) never caught this
 * because the bug only fires on an actual request, not at startup.
 * Reuses Contact.forLister — the same "my customers" list GET
 * /contacts/mine already returns for agent/company — including the
 * company-wide companyId scoping so a company can message a customer
 * who dealt with a property one of its agents lists, not just ones it
 * listed itself.
 */
async function assertListerCanMessage(listerUserId, targetUserId, authUser) {
  const companyId = await resolveCallerCompanyId(authUser);
  const contacts = await Contact.forLister(listerUserId, companyId);
  return contacts.some((c) => Number(c.user_id) === Number(targetUserId));
}

/** GET /messages (protected) — the current user's conversations */
router.get(
  '/',
  requireAuth,
  wrap(async (req, res) => {
    const rows = await Conversation.forUser(req.authUser.sub);
    return response.success(res, rows);
  })
);

/**
 * POST /messages (protected) — start a conversation with an opening
 * message, or continue the existing thread with the same other party
 * if one already exists (so clicking "Message" on the same agent
 * twice doesn't fork the conversation).
 */
router.post(
  '/',
  requireAuth,
  enforce((req) => `message-start:${req.authUser.sub}`, 30, 3600, 'Too many messages sent. Please wait before sending more.'),
  wrap(async (req, res) => {
    const v = new Validator(req.body);
    v.required('target_user_id').integer('target_user_id');
    v.required('message').max('message', 4000);
    if (v.fails()) return response.validationError(res, v.errors());
    const data = v.validated();

    const targetUserId = Number(data.target_user_id);
    if (targetUserId === req.authUser.sub) {
      return response.validationError(res, { target_user_id: ['You cannot message yourself.'] });
    }

    const target = await User.findById(targetUserId);
    if (!target) return response.notFound(res, 'Recipient not found.');

    if (req.authUser.role === 'customer') {
      if (target.role !== 'agent' && target.role !== 'company') {
        return response.forbidden(res, 'Customers can only message an agent or the company they work for.');
      }
      const allowed = await assertCustomerCanMessage(req.authUser.sub, targetUserId);
      if (!allowed) {
        logger.security('Blocked cold-message attempt', { from: req.authUser.sub, to: targetUserId });
        return response.forbidden(
          res,
          'You can only message an agent or company you have an active property relationship with.'
        );
      }
    } else if (req.authUser.role === 'agent' || req.authUser.role === 'company') {
      if (target.role !== 'customer') {
        return response.forbidden(res, 'Agents and companies can only message customers.');
      }
      const allowed = await assertListerCanMessage(req.authUser.sub, targetUserId, req.authUser);
      if (!allowed) {
        logger.security('Blocked cold-message attempt', { from: req.authUser.sub, to: targetUserId });
        return response.forbidden(
          res,
          'You can only message a customer who has viewed, purchased, or rented one of your listings.'
        );
      }
    } else if (req.authUser.role === 'admin') {
      // Joan, Sep 2026: "the messaging should cut across, companies
      // only." Deliberately no relationship check here (unlike the two
      // branches above) — see Contact.forAdmin()'s doc comment for why.
      if (target.role !== 'company') {
        return response.forbidden(res, 'Admin can only message companies.');
      }
    }

    const existingId = await Conversation.findBetween(req.authUser.sub, targetUserId);
    if (existingId) {
      await Conversation.addMessage(existingId, req.authUser.sub, data.message);
      await Notification.create(targetUserId, 'message', 'New message', 'You have a new message on HouseBank.');
      return response.created(res, { id: existingId }, 'Message sent.');
    }

    const conversationId = await Conversation.createWithMessage({
      userIdA: req.authUser.sub,
      userIdB: targetUserId,
      propertyId: data.property_id ? Number(data.property_id) : null,
      subject: data.subject || null,
      senderId: req.authUser.sub,
      body: data.message,
    });

    await Notification.create(targetUserId, 'message', 'New message', 'You have a new message on HouseBank.');
    logger.info('Conversation started', { conversation_id: conversationId, between: [req.authUser.sub, targetUserId] });
    return response.created(res, { id: conversationId }, 'Conversation started.');
  })
);

/**
 * POST /messages/contact-company (protected, customer only) — backs
 * the Help page's "Get in Touch" form. Unlike POST / above, the
 * recipient is never client-supplied: it's resolved server-side to
 * the customer's own most-recently-active company relationship (the
 * same Contact.forCustomer list "my realtor" and normal messaging
 * already trust), so this can't be used to cold-message an arbitrary
 * company. An automated acknowledgment is inserted into the same
 * thread immediately, so the customer gets a real, instant reply
 * while they wait for a human one.
 */
router.post(
  '/contact-company',
  requireAuth,
  requireRole('customer'),
  enforce((req) => `contact-company:${req.authUser.sub}`, 5, 3600, 'Too many messages sent. Please wait before sending more.'),
  wrap(async (req, res) => {
    const v = new Validator(req.body);
    v.required('message').min('message', 5).max('message', 4000);
    if (v.fails()) return response.validationError(res, v.errors());
    const { message } = v.validated();

    const contacts = await Contact.forCustomer(req.authUser.sub);
    const company = contacts.find((c) => c.contact_type === 'company');
    if (!company) {
      return response.notFound(
        res,
        "You don't have an active company relationship yet — book a property viewing first, or email Support@housebank.com directly."
      );
    }

    const companyUserId = company.user_id;
    const autoReply =
      `Thanks for reaching out! This confirms your message has been received by ${company.name} via HouseBank. ` +
      `We typically respond within 1 business day — you can follow this conversation any time from Messages.`;

    let conversationId = await Conversation.findBetween(req.authUser.sub, companyUserId);
    if (conversationId) {
      await Conversation.addMessage(conversationId, req.authUser.sub, message);
    } else {
      conversationId = await Conversation.createWithMessage({
        userIdA: req.authUser.sub,
        userIdB: companyUserId,
        propertyId: null,
        subject: 'Help & Support enquiry',
        senderId: req.authUser.sub,
        body: message,
      });
    }
    await Conversation.addAutomatedMessage(conversationId, companyUserId, autoReply);

    await Notification.create(
      companyUserId,
      'message',
      'New message',
      'A customer sent a message via Help & Support on HouseBank.'
    );
    await Notification.create(req.authUser.sub, 'message', `New message from ${company.name}`, autoReply);

    logger.info('Help & Support contact-company message sent', {
      conversation_id: conversationId,
      customer_id: req.authUser.sub,
      company_user_id: companyUserId,
    });

    return response.created(
      res,
      { conversation_id: conversationId, company_name: company.name },
      `Message sent to ${company.name}.`
    );
  })
);

/** GET /messages/:id (protected) — one conversation's message history */
router.get(
  '/:id',
  requireAuth,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const allowed = await Conversation.isParticipant(id, req.authUser.sub);
    if (!allowed) {
      logger.security('Blocked IDOR attempt on conversation read', { conversation_id: id, attempted_by: req.authUser.sub });
      return response.notFound(res, 'Conversation not found.');
    }
    const detail = await Conversation.detailFor(id, req.authUser.sub);
    return response.success(res, detail);
  })
);

/** POST /messages/:id (protected) — send a message into an existing conversation */
router.post(
  '/:id',
  requireAuth,
  enforce((req) => `message-send:${req.authUser.sub}`, 60, 3600, 'Too many messages sent. Please wait before sending more.'),
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const allowed = await Conversation.isParticipant(id, req.authUser.sub);
    if (!allowed) {
      logger.security('Blocked IDOR attempt on conversation write', { conversation_id: id, attempted_by: req.authUser.sub });
      return response.notFound(res, 'Conversation not found.');
    }
    const v = new Validator(req.body);
    v.required('body').max('body', 4000);
    if (v.fails()) return response.validationError(res, v.errors());

    const messageId = await Conversation.addMessage(id, req.authUser.sub, v.validated().body);
    return response.created(res, { id: messageId }, 'Message sent.');
  })
);

/** POST /messages/:id/read (protected) — mark my side of the conversation read */
router.post(
  '/:id/read',
  requireAuth,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const allowed = await Conversation.isParticipant(id, req.authUser.sub);
    if (!allowed) return response.notFound(res, 'Conversation not found.');
    await Conversation.markRead(id, req.authUser.sub);
    return response.success(res, null, 'Marked read.');
  })
);

module.exports = router;
