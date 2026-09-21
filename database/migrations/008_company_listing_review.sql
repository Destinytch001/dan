-- Migration 008: company review stage for agent-submitted listings.
--
-- Joan: "since a realtor can add a Property Listing for a company they
-- are registered under, the company must approve/vet the listing
-- before it shows for anyone to see." Previously every new listing
-- (whether submitted by the company itself or by one of its agents)
-- went straight into the single admin 'pending' queue -- the company
-- had no say before HouseBank's own admin ever saw it. This adds one
-- extra stage ahead of that, used only when the lister is an agent
-- attached to a company: 'pending_company_review' -> (company
-- approves) -> 'pending' -> (admin approves) -> 'approved'. A company
-- listing its own property, or an independent agent with no company,
-- is unaffected and still goes straight to 'pending' as before.
--
-- Apply with: mysql -u <user> -p <database> < 008_company_listing_review.sql

ALTER TABLE properties
    MODIFY COLUMN status ENUM('draft','pending_company_review','pending','approved','rejected','sold','rented','archived')
    NOT NULL DEFAULT 'draft';
