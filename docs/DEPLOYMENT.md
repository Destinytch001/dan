# Deploying HouseBank's backend to Namecheap (cPanel Node.js Selector)

This is a plain Node/Express app with real npm dependencies (unlike the
earlier PHP draft of this backend, which deliberately avoided them —
Node on shared hosting always needs `npm install` regardless, so there's
no equivalent reason to hand-roll everything here).

## 0. Requirements

- **Node.js 20 or newer**, selected in cPanel's Node.js Selector. Two of
  the security-critical dependencies (`file-type`, `nodemailer`) ship as
  ESM-only packages on their current, patched major versions and require
  Node ≥20 — see `docs/SECURITY.md` for why those versions matter.
- MySQL 5.7+ or 8.0 (same as any other cPanel MySQL database).

## 1. Create the MySQL database

cPanel → **MySQL Databases**: create a database (e.g.
`yourcpaneluser_housebank`), a user with a strong generated password,
and grant that user **All Privileges** on the database. Then in
**phpMyAdmin**, import `database/schema.sql` into it.

> **Already have a working local database with real data and the
> `009`-`015` migrations applied?** Import your own export instead of
> the bare schema — see `docs/DATABASE_EXPORT.md`, which replaces this
> step and picks back up at step 2 below.

## 2. Upload the files

Keep this backend in its **own folder**, separate from the frontend —
e.g.:

```
/home/yourcpaneluser/
├── hb-backend/     <- this project (what cPanel's Node.js Selector points at)
└── hb-frontend/    <- (or your frontend's build output, deployed separately)
```

Upload via Git, SFTP, or cPanel File Manager — whichever cPanel offers.
Do **not** upload `node_modules/` — you'll install dependencies on the
server in step 4.

## 3. Set up the Node.js App in cPanel

cPanel → **Setup Node.js App** → **Create Application**:

- **Node.js version**: the highest available (20+).
- **Application mode**: Production.
- **Application root**: `hb-backend` (the folder from step 2).
- **Application URL**: your API subdomain, e.g. `api.yourdomain.com`.
- **Application startup file**: `src/server.js`.

Click **Create**. cPanel generates a virtual environment and shows you
an "Enter to the virtual environment" command — you don't need it for
normal use.

## 4. Configure environment variables

Still on the Node.js App page, cPanel gives you an **Environment
Variables** section — this is where `.env` values go on this hosting
model (cPanel injects them into `process.env` for the app; you can
*also* keep a `.env` file per `.env.example` if you prefer, since
`dotenv` is loaded, but cPanel's own UI is the more discoverable place
so you don't lose track of what's set where):

- `NODE_ENV=production`
- `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASS` — from step 1 (`DB_HOST` is
  almost always `localhost`)
- `JWT_SECRET` — generate with:
  `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
- `FRONTEND_URL` — your deployed frontend's exact origin, used for CORS
  (comma-separate multiple origins if needed)
- SMTP settings — cPanel → **Email Accounts**: create a mailbox for your
  domain and point `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS` at it; no
  third-party email service required
- Paystack keys, when you get to that module (see `docs/ROADMAP.md`)

`PORT` is set automatically by cPanel/Passenger — don't override it.

## 5. Install dependencies and start

Back on the Node.js App page, click **Run NPM Install**. cPanel runs
`npm install` inside the app's virtual environment using the
`package.json` you uploaded. Once it finishes, click **Restart**.

Set safer file permissions over SSH or cPanel Terminal:

```
cd hb-backend
chmod -R 750 storage
```

## 6. Create the first admin account

There's no signup form for admins — intentional, see the comment atop
`database/seedAdmin.js`. Using cPanel's **Terminal**, or SSH if your
plan includes it, run it **inside the app's virtual environment** (the
Node.js App page shows the exact "enter virtualenv" command, something
like `source /home/user/nodevenv/hb-backend/20/bin/activate`, then `cd`
back into the app folder):

```
node database/seedAdmin.js admin@yourdomain.com 08012345678 "A-Strong-Password1"
```

## 7. Point the frontend at it

```
VITE_APP_BACKEND_HOST=https://api.yourdomain.com/
```

matches `src/redux/housebank.ts`'s `baseUrl: import.meta.env.VITE_APP_BACKEND_HOST`.

## 8. Verify

```
curl https://api.yourdomain.com/properties/types
```

should return the seeded property types as JSON. If it doesn't, check
the Node.js App page's log viewer in cPanel, and `storage/logs/app.log`
inside the app folder — the API never puts real error details in an HTTP
response body in production, by design.

## Ongoing hardening checklist

- Enable **AutoSSL** for the API subdomain — `server.js` redirects to
  HTTPS and sends HSTS, but only matters once a cert is actually issued.
- `storage/logs/security.log` is your audit trail (failed logins,
  lockouts, IDOR attempts, admin actions, CORS rejections) — check it or
  ship it somewhere you'll see alerts.
- Back up the database regularly (cPanel → Backup Wizard, or a cron'd
  `mysqldump`). This app moves money — backups are non-optional.
- Rotate `JWT_SECRET` if you ever suspect it leaked — invalidates every
  issued access token immediately (users just sign in again).
- Re-run `npm audit` periodically and after any `npm install` that
  changes lockfile contents — see `docs/SECURITY.md` for the two
  currently-known, deliberately-accepted moderate advisories and why.
