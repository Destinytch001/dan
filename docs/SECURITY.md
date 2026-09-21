# Security posture and known residual risk

## What's enforced everywhere

- Every query uses `mysql2`'s parameterized `?` placeholders via
  `pool.execute()` — real server-side prepared statements, never
  string-concatenated SQL.
- Passwords hashed with bcrypt (cost 12). OTP codes and refresh tokens
  are hashed at rest too — a database leak alone doesn't hand out usable
  credentials for any of the three.
- JWT access tokens are short-lived (30 min default) and stateless.
  Refresh tokens are opaque random strings (not JWTs), hashed, and
  rotated on every use — a stolen refresh token is only good for a
  single exchange before it's revoked.
- Rate limiting is DB-backed (`rate_limits` table), not an in-memory
  Map — this matters specifically because cPanel's Node.js Selector runs
  under Passenger, which can recycle the app process at any time; an
  in-memory limiter would silently reset to zero on every restart.
- File uploads are validated by sniffing real file content
  (`file-type`, reading actual bytes) — never the client-supplied
  filename or `Content-Type` header. Images are additionally re-encoded
  through Jimp, which decodes and redraws the pixel data, discarding
  anything that isn't genuine image data.
- Every mutating property endpoint re-checks server-side that the
  caller actually owns the resource (or is admin), independent of what
  the client claims — the standard IDOR defense.
- Everything internal runs in UTC — both the Node process
  (`process.env.TZ` is irrelevant here; comparisons use `NOW()`
  server-side) and the MySQL session (forced via `SET time_zone =
  '+00:00'` on every pooled connection, see `src/config/db.js`). This
  isn't cosmetic: a PHP prototype of this same backend hit a real bug
  where OTP codes looked expired instantly because the app server and
  the DB server disagreed about what timezone `NOW()` meant.

## Known `npm audit` findings — accepted deliberately, not overlooked

Run `npm audit` yourself; as of this build it reports two moderate
advisories, both upstream and both without a non-breaking fix available:

**`qs` (via `body-parser` via `express` 4.x)** — a DoS-class advisory
(array-limit bypass, attacker-controlled `isBuffer` check). The fix
requires either Express 5 (a major version with real ecosystem/behavior
differences, not worth the risk on a first production deploy to shared
hosting) or waiting for `body-parser` to widen its `qs` dependency
range. Mitigated in practice by this app's own 1MB request body cap
(`express.json({ limit: '1mb' })`) and by never processing deeply
nested, attacker-controlled object/array structures — every endpoint
reads specific named fields via the `Validator`, not arbitrary nested
input.

**`file-type` (bundled inside `jimp`'s dependency tree)** — an
infinite-loop DoS in an ASF/WMA parser. This project's own direct use of
`file-type` is on the current patched major version (loaded via dynamic
`import()` — see the comment in `src/utils/fileUpload.js` for why).
The vulnerable copy is one `jimp` bundles internally for its own format
auto-detection, and it's never reached with attacker-controlled input in
this codebase's flow: every buffer reaches `Jimp.read()` only *after*
this app's own (patched) `file-type` check has already confirmed it's a
genuine JPEG/PNG/WEBP and rejected everything else with a 422.

Re-run `npm audit` after any dependency update — if either upstream
project ships a fix, take it.

## Deliberately out of scope for this pass

- **Private document downloads.** `storage/uploads/documents/` holds ID
  scans, CAC certificates, and (once payments land) proof-of-payment
  images — nothing in this pass serves them back, not even to admins.
  There's no route yet. Building the authenticated, ownership-checked
  gate for it is the first item in `docs/ROADMAP.md`, on purpose: don't
  wire up access to sensitive documents as an afterthought.
- **Payments.** Real money movement (Paystack + manual proof-of-payment)
  deserves its own dedicated build-and-test pass, not a bolt-on here.
