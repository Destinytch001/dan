'use strict';

const { verifyAccessToken } = require('../utils/jwt');
const { logger } = require('../utils/logger');
const response = require('../utils/response');

function bearerToken(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * Verifies the Bearer JWT and attaches the decoded payload to
 * req.authUser. Use requireRole(...) after this to additionally
 * enforce RBAC on a route.
 */
function requireAuth(req, res, next) {
  const token = bearerToken(req);
  if (!token) {
    return response.unauthorized(res, 'Authentication required.');
  }

  const payload = verifyAccessToken(token);
  if (!payload) {
    logger.security('Rejected invalid/expired access token', { ip: req.ip });
    return response.unauthorized(res, 'Session expired or invalid. Please sign in again.');
  }

  req.authUser = payload;
  next();
}

/**
 * Returns middleware restricting the route to one or more roles. Use
 * AFTER requireAuth in the route's middleware chain.
 */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    const role = req.authUser && req.authUser.role;
    if (!role || !allowedRoles.includes(role)) {
      logger.security('Blocked access due to insufficient role', { required: allowedRoles, actual: role });
      return response.forbidden(res, 'You do not have permission to perform this action.');
    }
    next();
  };
}

module.exports = { requireAuth, requireRole, bearerToken };
