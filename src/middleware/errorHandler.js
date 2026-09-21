'use strict';

const multer = require('multer');
const { logger } = require('../utils/logger');
const response = require('../utils/response');
const { env } = require('../config/env');

/**
 * Central error handler — the last middleware registered in server.js.
 * Never leaks stack traces, file paths, or raw DB errors to the client:
 * everything gets logged server-side, and the client gets a generic
 * message unless the error explicitly marked itself safe to show
 * (e.g. FileUpload's validation errors set err.status = 422 with a
 * user-facing message).
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'File exceeds the maximum allowed size.'
        : err.code === 'LIMIT_UNEXPECTED_FILE'
        ? 'Unexpected file field.'
        : 'File upload failed.';
    return response.validationError(res, { file: [message] });
  }

  if (err.message === 'Not allowed by CORS') {
    logger.security('Blocked CORS request', { origin: req.get('origin'), path: req.path });
    return response.forbidden(res, 'Origin not allowed.');
  }

  const status = err.status || 500;

  if (status >= 500) {
    logger.error('Unhandled error', { message: err.message, stack: err.stack, path: req.path });
    if (env.NODE_ENV === 'development') {
      return response.error(res, err.message, status);
    }
    return response.serverError(res);
  }

  // 4xx errors thrown deliberately (e.g. from fileUpload validation) are
  // safe to show as-is.
  const errors = err.field ? { [err.field]: [err.message] } : undefined;
  return response.error(res, err.message, status, errors);
}

function notFoundHandler(req, res) {
  return response.notFound(res, 'Endpoint not found.');
}

module.exports = { errorHandler, notFoundHandler };
