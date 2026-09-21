'use strict';

const { pool, withTransaction } = require('../config/db');

function placeholders(arr) {
  return arr.map(() => '?').join(',');
}

/**
 * Resolves each user id's real display name/avatar regardless of role
 * — customer_profiles, agent_profiles, and companies each store the
 * name under a different table/column. Falls back to the user's email
 * if no role profile row exists yet (shouldn't normally happen, but
 * an honest fallback beats a blank name).
 */
async function resolveParticipants(userIds) {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (ids.length === 0) return new Map();

  const [users] = await pool.query(
    `SELECT id, role, email, avatar_path FROM users WHERE id IN (${placeholders(ids)})`,
    ids
  );
  const [customers] = await pool.query(
    `SELECT user_id, full_name, avatar_path FROM customer_profiles WHERE user_id IN (${placeholders(ids)})`,
    ids
  );
  const [agents] = await pool.query(
    `SELECT user_id, full_name, avatar_path FROM agent_profiles WHERE user_id IN (${placeholders(ids)})`,
    ids
  );
  const [companies] = await pool.query(
    `SELECT user_id, company_name, logo_path FROM companies WHERE user_id IN (${placeholders(ids)})`,
    ids
  );

  // Admin has no profile row to look up (unlike every other role), so
  // its display name/avatar are resolved right here from users itself:
  // a fixed "HouseBank Admin" label rather than the admin's own email
  // -- a company reading a thread with admin shouldn't see a personal
  // inbox address -- plus the migration-014 users.avatar_path column.
  const byId = new Map(
    users.map((u) => [
      u.id,
      {
        user_id: u.id,
        role: u.role,
        name: u.role === 'admin' ? 'HouseBank Admin' : u.email,
        avatar_path: u.role === 'admin' ? u.avatar_path : null,
      },
    ])
  );
  for (const c of customers) {
    const entry = byId.get(c.user_id);
    if (entry) {
      entry.name = c.full_name;
      entry.avatar_path = c.avatar_path;
    }
  }
  for (const a of agents) {
    const entry = byId.get(a.user_id);
    if (entry) {
      entry.name = a.full_name;
      entry.avatar_path = a.avatar_path;
    }
  }
  for (const c of companies) {
    const entry = byId.get(c.user_id);
    if (entry) {
      entry.name = c.company_name;
      entry.avatar_path = c.logo_path;
    }
  }
  return byId;
}

/** Finds an existing 1:1 conversation between two users, if any — so
 * messaging the same contact twice continues one thread instead of
 * forking a new one. Every conversation created through this module
 * has exactly two participants; that invariant is what makes this
 * simple two-join lookup correct. */
async function findBetween(userIdA, userIdB) {
  const [rows] = await pool.execute(
    `SELECT cp1.conversation_id
       FROM conversation_participants cp1
       JOIN conversation_participants cp2 ON cp2.conversation_id = cp1.conversation_id
      WHERE cp1.user_id = ? AND cp2.user_id = ?
      LIMIT 1`,
    [userIdA, userIdB]
  );
  return rows[0] ? rows[0].conversation_id : null;
}

/** Creates a new 1:1 conversation with its opening message, atomically. */
async function createWithMessage({ userIdA, userIdB, propertyId, subject, senderId, body }) {
  return withTransaction(async (connection) => {
    const [convResult] = await connection.execute(
      `INSERT INTO conversations (subject, related_property_id) VALUES (?, ?)`,
      [subject || null, propertyId || null]
    );
    const conversationId = convResult.insertId;
    await connection.query(
      `INSERT INTO conversation_participants (conversation_id, user_id, last_read_at) VALUES (?, ?, NULL), (?, ?, NULL)`,
      [conversationId, userIdA, conversationId, userIdB]
    );
    await connection.execute(`INSERT INTO messages (conversation_id, sender_id, body) VALUES (?, ?, ?)`, [
      conversationId,
      senderId,
      body,
    ]);
    await connection.execute(
      `UPDATE conversation_participants SET last_read_at = NOW() WHERE conversation_id = ? AND user_id = ?`,
      [conversationId, senderId]
    );
    return conversationId;
  });
}

async function isParticipant(conversationId, userId) {
  const [rows] = await pool.execute(
    `SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ? LIMIT 1`,
    [conversationId, userId]
  );
  return rows.length > 0;
}

/** All conversations the user is part of, with the other participant's
 * resolved identity, a last-message preview, and an unread count
 * (messages from the other side since this user's last_read_at). */
async function forUser(userId) {
  const [rows] = await pool.query(
    `SELECT c.id AS conversation_id, c.subject, c.related_property_id, c.created_at,
            cp_self.last_read_at,
            other.user_id AS other_user_id,
            lm.body AS last_message_body, lm.sender_id AS last_message_sender_id, lm.created_at AS last_message_at,
            (SELECT COUNT(*) FROM messages m
              WHERE m.conversation_id = c.id
                AND m.sender_id != ?
                AND (cp_self.last_read_at IS NULL OR m.created_at > cp_self.last_read_at)) AS unread_count
       FROM conversation_participants cp_self
       JOIN conversations c ON c.id = cp_self.conversation_id
       JOIN conversation_participants other ON other.conversation_id = c.id AND other.user_id != cp_self.user_id
       LEFT JOIN messages lm ON lm.id = (
         SELECT id FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC, id DESC LIMIT 1
       )
      WHERE cp_self.user_id = ?
      ORDER BY COALESCE(lm.created_at, c.created_at) DESC`,
    [userId, userId]
  );

  const participants = await resolveParticipants(rows.map((r) => r.other_user_id));

  return rows.map((r) => ({
    conversation_id: r.conversation_id,
    subject: r.subject,
    related_property_id: r.related_property_id,
    created_at: r.created_at,
    other_participant:
      participants.get(r.other_user_id) || {
        user_id: r.other_user_id,
        name: 'HouseBank user',
        role: null,
        avatar_path: null,
      },
    last_message: r.last_message_body
      ? { body: r.last_message_body, sender_id: r.last_message_sender_id, created_at: r.last_message_at }
      : null,
    unread_count: Number(r.unread_count) || 0,
  }));
}

/** One conversation's full message history, plus the resolved other
 * participant for the chat header. Caller must have already checked
 * isParticipant() — this does not re-check ownership itself. */
async function detailFor(conversationId, userId) {
  const [convRows] = await pool.execute(`SELECT * FROM conversations WHERE id = ?`, [conversationId]);
  const conversation = convRows[0];
  if (!conversation) return null;

  const [participantRows] = await pool.execute(
    `SELECT user_id FROM conversation_participants WHERE conversation_id = ? AND user_id != ?`,
    [conversationId, userId]
  );
  const otherUserId = participantRows[0] ? participantRows[0].user_id : null;
  const participants = await resolveParticipants(otherUserId ? [otherUserId] : []);

  const [messages] = await pool.execute(
    `SELECT id, sender_id, body, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC`,
    [conversationId]
  );

  return {
    conversation_id: conversation.id,
    subject: conversation.subject,
    related_property_id: conversation.related_property_id,
    other_participant: otherUserId
      ? participants.get(otherUserId) || { user_id: otherUserId, name: 'HouseBank user', role: null, avatar_path: null }
      : null,
    messages,
  };
}

async function addMessage(conversationId, senderId, body) {
  const [result] = await pool.execute(`INSERT INTO messages (conversation_id, sender_id, body) VALUES (?, ?, ?)`, [
    conversationId,
    senderId,
    body,
  ]);
  await pool.execute(
    `UPDATE conversation_participants SET last_read_at = NOW() WHERE conversation_id = ? AND user_id = ?`,
    [conversationId, senderId]
  );
  return result.insertId;
}

async function markRead(conversationId, userId) {
  await pool.execute(
    `UPDATE conversation_participants SET last_read_at = NOW() WHERE conversation_id = ? AND user_id = ?`,
    [conversationId, userId]
  );
}

/**
 * Inserts a message without moving the sender's own read marker.
 * addMessage() marks the sender's side read-up-to-now, which is right
 * for a message someone actually typed and sent themselves, but wrong
 * for an automated reply "from" a company/agent who never opened the
 * thread — that would silently hide the customer's real message from
 * their unread count. Used by the Help page's instant-acknowledgment
 * auto-reply (see modules/messages' POST /messages/contact-company).
 */
async function addAutomatedMessage(conversationId, senderId, body) {
  const [result] = await pool.execute(`INSERT INTO messages (conversation_id, sender_id, body) VALUES (?, ?, ?)`, [
    conversationId,
    senderId,
    body,
  ]);
  return result.insertId;
}

module.exports = {
  findBetween,
  createWithMessage,
  isParticipant,
  forUser,
  detailFor,
  addMessage,
  addAutomatedMessage,
  markRead,
};
