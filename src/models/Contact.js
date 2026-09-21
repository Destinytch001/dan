'use strict';

const { pool } = require('../config/db');

function placeholders(arr) {
  return arr.map(() => '?').join(',');
}

/**
 * Resolves the real agents/companies a customer has actually
 * interacted with — via a booked viewing, a purchase, a rental, or an
 * investment — never a directory of every agent on the platform. This
 * is what "my realtor" means at HouseBank, and it's also the
 * authorization source for who a customer is allowed to message (see
 * modules/messages): only someone this list returns.
 *
 * For a property listed by an individual agent, both the agent AND
 * (if that agent is attached to a company, via the property's own
 * company_id or the agent's current company_id) that company are
 * returned as separate, independently-messageable contacts. For a
 * property listed directly by a company account, only the company is
 * returned.
 */
async function forCustomer(customerUserId) {
  const [interactionRows] = await pool.query(
    `SELECT ip.property_id AS property_id, i.created_at AS created_at
       FROM investments i
       JOIN investment_properties ip ON ip.id = i.investment_property_id
      WHERE i.investor_user_id = ?
     UNION ALL
     SELECT property_id, created_at FROM property_purchases WHERE buyer_user_id = ?
     UNION ALL
     SELECT property_id, created_at FROM property_rentals WHERE tenant_user_id = ?
     UNION ALL
     SELECT property_id, created_at FROM property_viewings WHERE customer_user_id = ?`,
    [customerUserId, customerUserId, customerUserId, customerUserId]
  );
  if (interactionRows.length === 0) return [];

  const lastInteraction = new Map();
  for (const row of interactionRows) {
    const prev = lastInteraction.get(row.property_id);
    if (!prev || new Date(row.created_at) > new Date(prev)) {
      lastInteraction.set(row.property_id, row.created_at);
    }
  }
  const propertyIds = [...lastInteraction.keys()];

  const [properties] = await pool.query(
    `SELECT id, title, listed_by_user_id, company_id FROM properties WHERE id IN (${placeholders(propertyIds)})`,
    propertyIds
  );
  if (properties.length === 0) return [];

  const listerIds = [...new Set(properties.map((p) => p.listed_by_user_id))];
  const [listers] = await pool.query(
    `SELECT u.id AS user_id, u.role, u.email, u.phone,
            ap.full_name AS agent_name, ap.avatar_path AS agent_avatar, ap.company_id AS employer_company_id
       FROM users u
       LEFT JOIN agent_profiles ap ON ap.user_id = u.id
      WHERE u.id IN (${placeholders(listerIds)})`,
    listerIds
  );
  const listerById = new Map(listers.map((u) => [u.user_id, u]));

  const companyIds = new Set();
  const companyUserIds = new Set();
  for (const p of properties) {
    const lister = listerById.get(p.listed_by_user_id);
    if (p.company_id) companyIds.add(p.company_id);
    if (lister && lister.role === 'agent' && lister.employer_company_id) companyIds.add(lister.employer_company_id);
    if (lister && lister.role === 'company') companyUserIds.add(lister.user_id);
  }

  let companies = [];
  if (companyIds.size || companyUserIds.size) {
    const clauses = [];
    const params = [];
    if (companyIds.size) {
      clauses.push(`id IN (${placeholders([...companyIds])})`);
      params.push(...companyIds);
    }
    if (companyUserIds.size) {
      clauses.push(`user_id IN (${placeholders([...companyUserIds])})`);
      params.push(...companyUserIds);
    }
    const [rows] = await pool.query(
      `SELECT id, user_id, company_name, logo_path FROM companies WHERE ${clauses.join(' OR ')}`,
      params
    );
    companies = rows;
  }
  const companyById = new Map(companies.map((c) => [c.id, c]));
  const companyByUserId = new Map(companies.map((c) => [c.user_id, c]));

  const contacts = new Map();
  const touch = (key, base, propertyTitle, lastAt) => {
    const entry = contacts.get(key) || { ...base, properties: [], last_interaction_at: lastAt };
    if (!entry.properties.includes(propertyTitle)) entry.properties.push(propertyTitle);
    if (new Date(lastAt) > new Date(entry.last_interaction_at)) entry.last_interaction_at = lastAt;
    contacts.set(key, entry);
  };

  for (const p of properties) {
    const lastAt = lastInteraction.get(p.id);
    const lister = listerById.get(p.listed_by_user_id);
    if (!lister) continue;

    if (lister.role === 'agent') {
      touch(
        `agent:${lister.user_id}`,
        {
          contact_type: 'agent',
          user_id: lister.user_id,
          name: lister.agent_name || 'Agent',
          avatar_path: lister.agent_avatar,
          email: lister.email,
          phone: lister.phone,
        },
        p.title,
        lastAt
      );

      const employerCompany =
        (p.company_id && companyById.get(p.company_id)) ||
        (lister.employer_company_id && companyById.get(lister.employer_company_id));
      if (employerCompany) {
        touch(
          `company:${employerCompany.user_id}`,
          {
            contact_type: 'company',
            user_id: employerCompany.user_id,
            name: employerCompany.company_name,
            avatar_path: employerCompany.logo_path,
            email: null,
            phone: null,
          },
          p.title,
          lastAt
        );
      }
    } else if (lister.role === 'company') {
      const company = companyByUserId.get(lister.user_id);
      if (company) {
        touch(
          `company:${company.user_id}`,
          {
            contact_type: 'company',
            user_id: company.user_id,
            name: company.company_name,
            avatar_path: company.logo_path,
            email: lister.email,
            phone: lister.phone,
          },
          p.title,
          lastAt
        );
      }
    }
  }

  return [...contacts.values()].sort(
    (a, b) => new Date(b.last_interaction_at) - new Date(a.last_interaction_at)
  );
}

/**
 * Resolves the real customers a given agent/company (lister) has
 * actually interacted with — via a booked viewing, a purchase, or a
 * rental on a property they list — mirroring forCustomer() above but
 * from the other side of the relationship. This is "my customers" for
 * staff, and (see modules/messages) it's also the authorization
 * source for who an agent/company is allowed to message: only someone
 * this list returns, never a cold message to an arbitrary customer.
 */
// companyId is optional — a company account passes its own id so this
// also includes customers who dealt with a property one of its agents
// lists, not just properties the company listed itself directly.
async function forLister(listerUserId, companyId = null) {
  const ownerClause = companyId ? '(p.listed_by_user_id = ? OR p.company_id = ?)' : 'p.listed_by_user_id = ?';
  const ownerParams = companyId ? [listerUserId, companyId] : [listerUserId];
  const [interactionRows] = await pool.query(
    `SELECT pp.property_id AS property_id, pp.buyer_user_id AS customer_user_id, pp.created_at AS created_at
       FROM property_purchases pp
       JOIN properties p ON p.id = pp.property_id
      WHERE ${ownerClause}
     UNION ALL
     SELECT pr.property_id, pr.tenant_user_id AS customer_user_id, pr.created_at
       FROM property_rentals pr
       JOIN properties p ON p.id = pr.property_id
      WHERE ${ownerClause}
     UNION ALL
     SELECT pv.property_id, pv.customer_user_id, pv.created_at
       FROM property_viewings pv
       JOIN properties p ON p.id = pv.property_id
      WHERE ${ownerClause}`,
    [...ownerParams, ...ownerParams, ...ownerParams]
  );
  if (interactionRows.length === 0) return [];

  const propertyIds = [...new Set(interactionRows.map((r) => r.property_id))];
  const [properties] = await pool.query(
    `SELECT id, title FROM properties WHERE id IN (${placeholders(propertyIds)})`,
    propertyIds
  );
  const propertyById = new Map(properties.map((p) => [p.id, p.title]));

  const customerIds = [...new Set(interactionRows.map((r) => r.customer_user_id))];
  const [customers] = await pool.query(
    `SELECT u.id AS user_id, u.email, u.phone, cp.full_name, cp.avatar_path
       FROM users u
       LEFT JOIN customer_profiles cp ON cp.user_id = u.id
      WHERE u.id IN (${placeholders(customerIds)})`,
    customerIds
  );
  const customerById = new Map(customers.map((c) => [c.user_id, c]));

  const contacts = new Map();
  for (const row of interactionRows) {
    const customer = customerById.get(row.customer_user_id);
    if (!customer) continue;
    const entry = contacts.get(row.customer_user_id) || {
      contact_type: 'customer',
      user_id: customer.user_id,
      name: customer.full_name || 'Customer',
      avatar_path: customer.avatar_path,
      email: customer.email,
      phone: customer.phone,
      properties: [],
      last_interaction_at: row.created_at,
    };
    const title = propertyById.get(row.property_id);
    if (title && !entry.properties.includes(title)) entry.properties.push(title);
    if (new Date(row.created_at) > new Date(entry.last_interaction_at)) entry.last_interaction_at = row.created_at;
    contacts.set(row.customer_user_id, entry);
  }

  return [...contacts.values()].sort(
    (a, b) => new Date(b.last_interaction_at) - new Date(a.last_interaction_at)
  );
}

/**
 * Who admin is allowed to message: every company on the platform, full
 * stop -- unlike forCustomer()/forLister() above, this is NOT scoped to
 * an existing transaction relationship. Every other role's messaging is
 * gated to people they've actually dealt with because a stranger
 * cold-messaging another stranger is exactly what that gate exists to
 * stop; admin messaging a company it hasn't "dealt with" yet is not a
 * cold message, it's the platform's own vetting authority reaching a
 * company it oversees by design (see Company.verify/rejectVerification
 * -- admin's real job is vetting every company, not just some of them).
 * Joan, Sep 2026: "the messaging should cut across, companies only."
 */
async function forAdmin() {
  const [rows] = await pool.query(
    `SELECT u.id AS user_id, c.company_name AS name, c.logo_path AS avatar_path,
            u.email, u.phone, c.verification_status
       FROM companies c
       JOIN users u ON u.id = c.user_id
      WHERE u.deleted_at IS NULL
      ORDER BY c.company_name ASC`
  );
  return rows.map((r) => ({ contact_type: 'company', ...r }));
}

module.exports = { forCustomer, forLister, forAdmin };
