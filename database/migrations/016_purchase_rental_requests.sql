-- 016_purchase_rental_requests.sql
--
-- Customer-initiated Buy/Rent requests (Joan, Sep 2026: the customer
-- dashboard's Buy/Rent page was calling the staff-only POST /purchases
-- and POST /rentals directly, which 403's for every real customer --
-- those routes are staff-only by design, see purchases.routes.js's own
-- comment). Decision: a customer submits a request, staff approves or
-- declines it -- mirroring how property_viewings already works
-- ('requested' -> staff acts on it), rather than opening self-service
-- checkout or removing the Buy/Rent buttons.
--
-- Adds a 'requested' entry state and a 'declined' terminal state ahead
-- of the existing staff-recorded 'pending_payment' flow, which is
-- unchanged -- POST /purchases and POST /rentals (staff, direct record)
-- still create rows straight into 'pending_payment' exactly as before.
-- staff_note carries an optional message back to the customer on
-- approval or decline (e.g. why a request was turned down).
--
-- Rewritten idempotent (Sep 2026, after Joan's first run errored
-- "Duplicate column name 'staff_note'" on the property_purchases
-- statement): mysql's CLI stops at the first error in a script, so that
-- run's property_purchases ALTER had already fully applied on an
-- earlier attempt, then property_rentals never got reached this time.
-- MODIFY COLUMN is naturally safe to re-run; each ADD COLUMN is now
-- guarded by an information_schema check so re-running this file always
-- finishes both tables, however far a previous attempt got.
--
-- Run once against each database (local now; the Namecheap production
-- DB via the docs/DATABASE_EXPORT.md dump/import, or run here directly
-- if applied ahead of that import):
--   mysql -u <db_user> -p <db_name> < database/migrations/016_purchase_rental_requests.sql

ALTER TABLE property_purchases
  MODIFY COLUMN status ENUM('requested','declined','pending_payment','processing','completed','cancelled') NOT NULL DEFAULT 'pending_payment';

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'property_purchases' AND column_name = 'staff_note'
);
SET @ddl = IF(@col_exists = 0,
  'ALTER TABLE property_purchases ADD COLUMN staff_note VARCHAR(500) NULL AFTER agreed_price',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

ALTER TABLE property_rentals
  MODIFY COLUMN status ENUM('requested','declined','pending_payment','active','expired','terminated','cancelled') NOT NULL DEFAULT 'pending_payment';

SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE() AND table_name = 'property_rentals' AND column_name = 'staff_note'
);
SET @ddl = IF(@col_exists = 0,
  'ALTER TABLE property_rentals ADD COLUMN staff_note VARCHAR(500) NULL AFTER rent_period_months',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
