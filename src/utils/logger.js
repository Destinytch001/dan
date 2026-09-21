'use strict';

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', '..', 'storage', 'logs');

function write(channel, level, message, context) {
  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o750 });
    }
    const line = `[${new Date().toISOString()}] ${level.toUpperCase()}: ${message} ${
      context ? JSON.stringify(context) : ''
    }\n`;
    fs.appendFileSync(path.join(LOG_DIR, `${channel}.log`), line);
  } catch (err) {
    // Never let logging itself crash a request.
    // eslint-disable-next-line no-console
    console.error('Logger write failed:', err.message);
  }
}

const logger = {
  info: (message, context) => write('app', 'info', message, context),
  warning: (message, context) => write('app', 'warning', message, context),
  error: (message, context) => write('app', 'error', message, context),
  // Security-relevant events kept in a separate file — failed logins,
  // lockouts, rejected tokens, IDOR attempts, admin actions.
  security: (message, context) => write('security', 'security', message, context),
};

module.exports = { logger };
