# Moving your local database to Namecheap MySQL

`database/schema.sql` is a base schema only — it predates migrations
`009`-`015` (site content seeding, admin seed, realtor invites, property
moderation, and more). Importing just `schema.sql` on production, as
`docs/DEPLOYMENT.md` step 1 shows for a from-scratch install, would give
you an empty, out-of-date database. Since you already have a working
local database, exporting *that* (after catching it up) is the better
path and replaces `DEPLOYMENT.md` step 1 entirely — skip straight to its
step 2 once you've done this.

There's no migration-tracking table in this project — migrations are
plain numbered `.sql` files you run once, in order, by hand.

## 1. Catch your local database up first

Run any of `009` through `015` you haven't applied yet, **in order**,
against your local database:

```
cd hb-backend/database/migrations
mysql -u hb_user -p hb_database < 009_site_content_seed.sql
mysql -u hb_user -p hb_database < 010_admin_seed.sql
mysql -u hb_user -p hb_database < 011_realtor_invite_token.sql
mysql -u hb_user -p hb_database < 012_property_moderation.sql
mysql -u hb_user -p hb_database < 013_fix_stuck_pending_properties.sql
mysql -u hb_user -p hb_database < 014_admin_avatar.sql
mysql -u hb_user -p hb_database < 015_page_content.sql
```

(`mysql -p` prompts for your password interactively — never put it on
the command line.) Each one is written to fail loudly on a unique-key
error if it's already been applied, which is the safe/expected outcome
of re-running one by accident — if you're not sure which you've already
run, just run all seven; the ones already applied will error out
harmlessly and the rest will apply.

`010_admin_seed.sql` is your real production admin login
(`dantechhubict@gmail.com`, password given to you directly in chat when
that migration was written — not stored anywhere in this repo). `009`
seeds the real Privacy Policy / Anti-Discrimination / Help / Testimonials
content. Once you dump and import (below), both come with it — you do
**not** need to separately run `npm run seed:admin` on production
(`DEPLOYMENT.md` step 6) unless you specifically want a *different*
admin account than the one `010` already created.

## 2. Export it

```
mysqldump -u hb_user -p --routines --triggers hb_database > housebank_export.sql
```

`--routines --triggers` is there in case any exist now or get added
later — harmless no-op if there aren't any yet.

## 3. Create the destination database in cPanel

cPanel → **MySQL Databases** → create a database and user (same as
`DEPLOYMENT.md` step 1), grant that user **All Privileges** on it. Note
the exact database name cPanel gives you — it'll be prefixed with your
cPanel username, e.g. `yourcpaneluser_housebank`, not just `hb_database`.

## 4. Import

cPanel → **phpMyAdmin** → select the new (empty) database → **Import**
tab → choose `housebank_export.sql` → Go.

If phpMyAdmin rejects the file as too large (shared hosting commonly
caps this around 50 MB): gzip it first —

```
gzip housebank_export.sql
```

— phpMyAdmin's Import tab accepts `.sql.gz` directly and most cPanel
plans raise the effective limit for compressed files. If it's still too
large, cPanel's **Terminal** (if your plan includes it) can run the
import server-side without going through the upload limit at all:

```
mysql -u yourcpaneluser_housebank -p yourcpaneluser_housebank < housebank_export.sql
```

## 5. Point the backend at it

Set `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASS` in cPanel's Node.js App
environment variables (`DEPLOYMENT.md` step 4) to this new database's
real credentials — not your local ones.

## 6. Verify

```
curl https://api.yourdomain.com/properties/types
```

should return real rows (not an empty array) once the backend is
running against the imported database — confirms both the import and
the connection env vars are correct. Then sign in as
`dantechhubict@gmail.com` on the deployed frontend to confirm the admin
account carried over.
