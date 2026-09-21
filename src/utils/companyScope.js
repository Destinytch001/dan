'use strict';

const Company = require('../models/Company');
const AgentProfile = require('../models/AgentProfile');

/**
 * A company account's own company_id, or the company_id an agent is
 * currently attached to (null for an independent agent, or for any
 * other role). Shared by every module that scopes "my listings" /
 * "my customers" / "my revenue" to the whole company roster rather
 * than just the caller's own listed_by_user_id — so a company sees
 * deals on properties its agents list too, not only the ones it
 * listed itself.
 */
async function resolveCallerCompanyId(authUser) {
  if (authUser.role === 'company') {
    const company = await Company.findByUserId(authUser.sub);
    return company ? company.id : null;
  }
  if (authUser.role === 'agent') {
    const profile = await AgentProfile.findByUserId(authUser.sub);
    return profile ? profile.company_id : null;
  }
  return null;
}

module.exports = { resolveCallerCompanyId };
