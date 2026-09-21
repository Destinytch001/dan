# Roadmap — what's built vs. what's next

This backend ships in phases so each piece can be tested against real
money-adjacent logic before the next is layered on. This document is
the honest state of things, not a marketing plan.

## Built and tested this pass

- **Auth**: signup (customer/agent/company, with document upload for
  agent/company), email OTP verification, resend, signin (email or
  phone), refresh-token rotation, logout, forgot/reset password,
  account lockout after repeated failed logins, DB-backed rate
  limiting on all of it.
- **Properties**: public search/browse (paginated, filterable,
  full-text), owner-scoped create/edit/delete, image upload
  (content-sniffed, re-encoded), admin approve/reject queue. Editing
  an approved listing demotes it back to `pending` — a seller can't
  silently swap in different photos/price after approval.
- **Content/CMS**: static pages, help topics, testimonials, blog —
  all DB-backed with admin-only writes. This is what makes the
  About/Privacy/FAQ/Blog screens dynamic instead of hardcoded JSX
  strings, per the "everything dynamic, nothing static" requirement.
- **Schema**: all 33 tables for the full platform exist in
  `database/schema.sql` and are loaded/verified against a real MySQL
  instance, even though several modules below don't have routes yet.
  Building the schema once, completely, avoids painful migrations
  later — the tables for investments/subscriptions/messaging are
  there and ready when those modules get built.

## Next up, roughly in build order

1. **Private document download gate.** `storage/uploads/documents/`
   already receives ID scans and CAC certificates on signup, but
   nothing serves them back yet — not even to admins. This needs its
   own authenticated, ownership-or-admin-checked route
   (`GET /admin/documents/:id` or similar) before it's useful, and it's
   first on purpose: sensitive-document access shouldn't be an
   afterthought bolted onto another module.
2. **Agent/company verification workflow.** Admin review of the
   uploaded ID/CAC documents, an approve/reject action that flips
   `users.status` and/or a dedicated `verification_status` column,
   and (once #1 exists) the download route to actually view what was
   submitted.
3. **Payments — hybrid model.**
   - Paystack for subscriptions and investment contributions:
     initialize → webhook → verify signature → mark
     `transactions`/`subscriptions`/`investments` row paid. The
     `payment_webhook_events` table exists specifically to make
     webhook handling idempotent (store the event ID, ignore
     replays) — Paystack retries webhooks and a naive handler will
     double-credit an investment otherwise.
   - Manual proof-of-payment for large one-off property purchases:
     buyer uploads a receipt/transfer screenshot (via the same
     `storeDocument()` path as ID/CAC uploads — it's already built
     for exactly this), admin reviews and confirms in the dashboard,
     transaction flips to `confirmed`.
4. **Investments.** List/browse investment-type properties (schema
   already supports `listing_type = 'investment'`), contribute via
   Paystack (needs #3 first), track per-user investment holdings,
   admin-reviewed withdrawal requests
   (`investment_withdrawal_requests` table already exists).
5. **Subscriptions.** Plan selection, Paystack recurring charge,
   `subscriptions` table tracks status/expiry — gates whatever
   premium listing features the frontend expects (e.g. featured
   placement, more active listings).
6. **Company ↔ agent management.** A company invites/adds agents
   (`company_agents`, `realtor_transfer_requests` tables exist);
   an agent can be affiliated with one company at a time and request
   transfer between companies to hand it over cleanly.
7. **Messaging/notifications.** `conversations`,
   `conversation_participants`, `messages`, `notifications` tables
   exist. Likely needs polling endpoints at minimum
   (`GET /notifications`, `GET /conversations/:id/messages`); a
   websocket layer is a bigger lift on shared hosting (Passenger
   doesn't do persistent connections cleanly) and should be scoped
   as its own decision, not assumed.
8. **Reviews and disputes.** Straightforward CRUD, but reviews should
   only be postable by a user with a completed transaction against
   that listing/agent (an IDOR-style check, same pattern as
   properties) — otherwise it's just a public comment box with no
   trust signal.
9. **Admin analytics.** Dashboard counts/charts (users by role,
   pending approvals, transaction volume, top listings). Pure
   read-side aggregation queries once the data above exists to
   aggregate.

## Known frontend debt (not a backend gap)

The frontend's RTK Query layer (`src/redux/housebank.ts` and the
per-screen slices) was built against no real backend, so a
significant share of its ~150 screens still need their mutations
pointed at real endpoints once each module above ships — starting
with the signup forms, which currently `console.log(formData)`
instead of calling `useRegisterUserMutation()` (see
`docs/API_CONTRACT.md`'s note on this). Track this per-module as each
backend piece lands, rather than as one big wiring pass at the end.

## Content population (not a backend gap either)

The CMS endpoints and tables exist and are tested, but the actual
copy currently hardcoded in `PrivacyPolicy.tsx`,
`AntiDiscrimniation.tsx`, `FAQ.tsx`, and similar screens hasn't been
moved into the `static_pages`/`help_topics` tables yet. That's a
one-time data-entry task (`PUT /content/pages/:slug` per page),
not new code.
