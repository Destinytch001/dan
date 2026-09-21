'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');

const { env } = require('./config/env');
const { logger } = require('./utils/logger');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { verifyMailTransport } = require('./utils/mailer');
const { verifyDatabaseConnection } = require('./config/db');

const authRoutes = require('./modules/auth/auth.routes');
const propertyRoutes = require('./modules/properties/properties.routes');
const adminRoutes = require('./modules/admin/admin.routes');
const contentRoutes = require('./modules/content/content.routes');
const notificationRoutes = require('./modules/notifications/notifications.routes');
const investmentRoutes = require('./modules/investments/investments.routes');
const transactionRoutes = require('./modules/transactions/transactions.routes');
const purchaseRoutes = require('./modules/purchases/purchases.routes');
const rentalRoutes = require('./modules/rentals/rentals.routes');
const viewingRoutes = require('./modules/viewings/viewings.routes');
const contactRoutes = require('./modules/contacts/contacts.routes');
const messageRoutes = require('./modules/messages/messages.routes');
const profileRoutes = require('./modules/profile/profile.routes');
const paymentMethodRoutes = require('./modules/payment-methods/payment-methods.routes');
const companyAgentRoutes = require('./modules/company-agents/company-agents.routes');
const companyRoutes = require('./modules/companies/companies.routes');
const agentRoutes = require('./modules/agents/agents.routes');
const leadRoutes = require('./modules/leads/leads.routes');
const reportRoutes = require('./modules/reports/reports.routes');
const reviewRoutes = require('./modules/reviews/reviews.routes');

const app = express();
const isDebugMode = env.NODE_ENV !== 'production' || process.env.DEBUG === 'true';

if (isDebugMode) {
  app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - startedAt;
      // eslint-disable-next-line no-console
      console.log(`[DEBUG] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${duration}ms)`);
    });
    next();
  });
}

// Trust the first proxy hop — Namecheap's Node.js Selector runs behind
// Apache/LiteSpeed via Passenger, so req.ip needs this to reflect the
// real client IP (used for rate limiting and audit logs) instead of
// always resolving to localhost.
app.set('trust proxy', 1);

// ---------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------
app.use(
  helmet({
    contentSecurityPolicy: false, // this is a pure JSON API, not serving HTML — CSP is the frontend's concern
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // uploaded images are fetched from the frontend's origin
  })
);
if (env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    // Never force HTTPS on localhost/127.0.0.1 — there is no TLS listener
    // there in local dev, so forcing this redirect turns every local
    // request into an unreachable https://localhost request (this bit a
    // real local test: NODE_ENV was left at the .env.example default of
    // "production" while testing against http://localhost:3001).
    const host = req.hostname || '';
    if (host === 'localhost' || host === '127.0.0.1') return next();

    // Only send HSTS once HTTPS is fully enforced (Namecheap AutoSSL
    // enabled + the redirect below) — see docs/DEPLOYMENT.md.
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (req.protocol !== 'https' && req.get('x-forwarded-proto') !== 'https') {
      return res.redirect(301, `https://${req.get('host')}${req.originalUrl}`);
    }
    next();
  });
}

// ---------------------------------------------------------------------
// CORS — locked to the known frontend origin(s), never a wildcard when
// credentials/auth headers are in play.
// ---------------------------------------------------------------------
const allowedOrigins = env.FRONTEND_URL.split(',').map((o) => o.trim()).filter(Boolean);
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400,
  })
);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Publicly served files ONLY — property photos, avatars, logos, blog
// covers. Sensitive documents (ID scans, CAC certs, payment proofs)
// live under storage/, outside this static mount, and are never served
// from here — see docs/ROADMAP.md for the planned gated download route.
app.use('/uploads', express.static(path.join(__dirname, '..', 'public', 'uploads'), {
  setHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
  },
}));

// ---------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------
app.use('/auth', authRoutes);
app.use('/properties', propertyRoutes);
app.use('/admin', adminRoutes);
app.use('/content', contentRoutes);
app.use('/notifications', notificationRoutes);
app.use('/investments', investmentRoutes);
app.use('/transactions', transactionRoutes);
app.use('/purchases', purchaseRoutes);
app.use('/rentals', rentalRoutes);
app.use('/viewings', viewingRoutes);
app.use('/contacts', contactRoutes);
app.use('/messages', messageRoutes);
app.use('/profile', profileRoutes);
app.use('/payment-methods', paymentMethodRoutes);
app.use('/company-agents', companyAgentRoutes);
app.use('/companies', companyRoutes);
app.use('/agents', agentRoutes);
app.use('/leads', leadRoutes);
app.use('/reports', reportRoutes);
app.use('/reviews', reviewRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

// cPanel's Node.js Selector (Passenger) expects the app to listen on the
// PORT it assigns via the environment — env.PORT already reads
// process.env.PORT with a local-dev fallback.
async function startServer() {
  try {
    await verifyDatabaseConnection();
    app.listen(env.PORT, () => {
      logger.info(`HouseBank API listening on port ${env.PORT} (${env.NODE_ENV})`);
      // eslint-disable-next-line no-console
      console.log(`HouseBank API listening on port ${env.PORT} (${env.NODE_ENV})`);
      // Fire-and-forget -- logs a clear pass/fail for whichever mail driver
      // is configured without delaying the port bind (see mailer.js's own
      // comment on verifyMailTransport for why this exists).
      verifyMailTransport();
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[HouseBank] Startup failed: database connection check failed.');
    // eslint-disable-next-line no-console
    console.error(err.message);
    process.exit(1);
  }
}

startServer();

process.on('unhandledRejection', (err) => {
  logger.error('Unhandled promise rejection', { message: err.message, stack: err.stack });
});

module.exports = app;
