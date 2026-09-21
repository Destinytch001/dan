# HouseBank API contract — v1 (Auth + Properties + Content)

Base URL: `{VITE_APP_BACKEND_HOST}` (e.g. `https://api.yourdomain.com/`)

Every response is JSON shaped as:

```json
{ "success": true, "message": "...", "data": { ... } }
```

or on failure:

```json
{ "success": false, "message": "...", "errors": { "field": ["reason"] } }
```

`errors` is only present on 422 validation failures. This matches the
frontend's existing `transformResponse: (response) => response.data`
pattern in `src/redux/housebank.ts`.

Protected routes require `Authorization: Bearer <token>`. Tokens expire
in 30 minutes (`JWT_ACCESS_TTL_SECONDS`); use `/auth/refresh` with the
stored `refreshToken` to get a new pair without forcing re-login.

---

## Auth

### `POST /auth/signup`
`multipart/form-data` when a file is attached (agent/company), JSON otherwise.

| field | type | required | notes |
|---|---|---|---|
| role | string | yes | `customer` \| `agent` \| `company` |
| email | string | yes | |
| phone | string | yes | Nigerian format: `0801...` or `+234801...` |
| password | string | yes | min 8 chars, letter + number |
| fullName | string | if role=customer/agent | |
| idFile | file | if role=agent | JPG/PNG/PDF, ≤5MB |
| companyName | string | if role=company | |
| companyAddress | string | if role=company | |
| cacNumber | string | if role=company | |
| cacFile | file | if role=company | JPG/PNG/PDF, ≤5MB |

**Frontend wiring note**: `SignUp.tsx`, `SignUpBuyer.tsx`, and
`SignUpUser.tsx` currently `console.log(formData)` — they need to call
`useRegisterUserMutation()` with a `FormData` body (not JSON) whenever a
file is attached.

Response `201`: `{ user_id, email }`. Does not log the user in — an OTP
is emailed first (or logged to `storage/logs/app.log` in development
when `SMTP_HOST` isn't configured).

### `POST /auth/verify-otp`
Body: `{ userId, code }` — 6-digit code, expires in 10 minutes.
Response `200`: `{ token, refreshToken, user }`.

### `POST /auth/resend-otp`
Body: `{ userId, purpose }` — `signup_verification` or `password_reset`.
Rate-limited. Always returns a generic success message.

### `POST /auth/signin`
Body: `{ userName, password }` — `userName` accepts an email **or** a
phone number (kept as `userName` to match `AuthContext.tsx`'s existing contract).
Response `200`: `{ token, refreshToken, user }`.
`403` with `{ requires_verification: true, user_id }` if unverified.
`423` if temporarily locked from repeated failed logins.

### `POST /auth/refresh`
Body: `{ refreshToken }`. Rotates the token. Response `200`: `{ token, refreshToken }`.

### `POST /auth/logout` (protected)
Revokes all refresh tokens for the user.

### `GET /auth/me` (protected)

### `POST /auth/forgot-password`
Body: `{ email }`. Always generic.

### `POST /auth/reset-password`
Body: `{ email, code, newPassword }`.

---

## Properties

### `GET /properties` (public)
Query: `page`, `per_page` (max 50), `listing_type` (`sale`\|`rent`\|`investment`),
`city`, `state`, `property_type_id`, `min_price`, `max_price`, `q` (full-text search).
Only `status = approved` listings. Response: `{ items, total, page, per_page }`.

### `GET /properties/types` (public)

### `GET /properties/:id` (public)
Approved only. Increments `views_count`.

### `GET /properties/mine` (protected — agent/company)
Query: `status` (optional). Any status, own listings only.

### `POST /properties` (protected — agent/company)
Required: `property_type_id, listing_type, title, price, address, city, state`.
Optional: `description, bedrooms, bathrooms, size_sqm, latitude, longitude`.
Always created as `status = pending`.

### `POST /properties/:id/images` (protected — owner only)
Multipart, field name `images` (multiple), max 15 per property.

### `PUT /properties/:id` (protected — owner only)
Partial update. **Editing an already-approved listing resets it to `pending`.**

### `DELETE /properties/:id` (protected — owner or admin)
Soft delete.

---

## Admin — property approval

- `GET /admin/properties/pending` — Query: `page`, `per_page`.
- `POST /admin/properties/:id/approve`
- `POST /admin/properties/:id/reject` — Body: `{ reason }`.

---

## Content (CMS) — new this pass

Makes the About/Privacy Policy/Anti-Discrimination/Help Center/Blog/
testimonials screens DB-driven instead of hardcoded React strings.

### Public reads
- `GET /content/pages/:slug` — e.g. `privacy-policy`, `anti-discrimination`.
- `GET /content/help-topics?category=...`
- `GET /content/testimonials?featured=1`
- `GET /content/blog?page=&per_page=` — published posts only.
- `GET /content/blog/:slug`

### Admin writes (protected — admin only)
- `PUT /content/pages/:slug` — Body: `{ title, content_html }` (creates or replaces).
- `POST /content/help-topics` — Body: `{ category, question, answer, sort_order? }`.
- `PUT /content/help-topics/:id`, `DELETE /content/help-topics/:id`
- `POST /content/testimonials` — multipart if `avatar` file attached. Body: `{ name, role?, rating?, quote, is_featured? }`.
- `DELETE /content/testimonials/:id`
- `POST /content/blog` — multipart if `cover` file attached. Body: `{ title, slug, excerpt?, content_html, status? }`.
- `PUT /content/blog/:id`

**Note**: the actual copy currently hardcoded in `PrivacyPolicy.tsx`,
`AntiDiscrimniation.tsx`, `FAQ.tsx`, etc. hasn't been migrated into these
tables yet — that's a content-population task, not a backend gap. The
endpoints and schema are ready for it.

---

## Error status codes used throughout

| Code | Meaning |
|---|---|
| 401 | Missing/invalid/expired token, or wrong credentials |
| 403 | Authenticated but not allowed to touch this resource (RBAC / IDOR block) |
| 404 | Not found (or exists but not visible to this caller) |
| 422 | Validation failed — see `errors` |
| 423 | Account temporarily locked |
| 429 | Rate limited |
| 500 | Server error — details in `storage/logs/app.log`, never in the response |
