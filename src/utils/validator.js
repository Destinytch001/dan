'use strict';

/**
 * Small rule-based validator — whitelist validation on every input field
 * before it touches a query or the filesystem. Deliberately hand-rolled
 * instead of pulling in a schema library: the rules actually used here
 * are simple enough that a dependency buys nothing but another package
 * to keep patched.
 *
 * Usage:
 *   const v = new Validator(req.body);
 *   v.required('email').email('email');
 *   v.required('password').min('password', 8);
 *   if (v.fails()) return response.validationError(res, v.errors());
 */
class Validator {
  constructor(data) {
    this.data = data || {};
    this.errs = {};
  }

  value(field) {
    return this.data[field];
  }

  addError(field, message) {
    if (!this.errs[field]) this.errs[field] = [];
    this.errs[field].push(message);
  }

  fails() {
    return Object.keys(this.errs).length > 0;
  }

  errors() {
    return this.errs;
  }

  validated() {
    return this.data;
  }

  /**
   * A whitespace-only string ("   ") used to pass this as "present" —
   * every other rule in this class treats a value as absent once it's
   * `undefined`/`null`/`''`, so a field that's only spaces slipped
   * through required() and then landed in the database as blank-looking
   * junk instead of being rejected outright.
   */
  required(field, label) {
    const v = this.value(field);
    const isBlank =
      v === undefined ||
      v === null ||
      (typeof v === 'string' && v.trim() === '') ||
      (Array.isArray(v) && v.length === 0);
    if (isBlank) {
      this.addError(field, `${label || field} is required.`);
    }
    return this;
  }

  email(field) {
    const v = this.value(field);
    if (v !== undefined && v !== null && v !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v))) {
      this.addError(field, 'Must be a valid email address.');
    }
    return this;
  }

  phone(field) {
    const v = this.value(field);
    if (v !== undefined && v !== null && v !== '' && !/^(\+?234|0)[789][01]\d{8}$/.test(String(v))) {
      this.addError(field, 'Must be a valid Nigerian phone number.');
    }
    return this;
  }

  /**
   * String-length checks. Coerces to a string first, same as every other
   * rule below — previously this guarded on `typeof v === 'string'` and
   * silently skipped anything else, so a client sending a field as a
   * JSON number (e.g. a "bio" or "message" body that happens to be all
   * digits) bypassed length validation entirely instead of being
   * measured like any other input.
   */
  min(field, length) {
    const v = this.value(field);
    if (v !== undefined && v !== null && v !== '' && String(v).length < length) {
      this.addError(field, `Must be at least ${length} characters.`);
    }
    return this;
  }

  max(field, length) {
    const v = this.value(field);
    if (v !== undefined && v !== null && v !== '' && String(v).length > length) {
      this.addError(field, `Must not exceed ${length} characters.`);
    }
    return this;
  }

  numeric(field) {
    const v = this.value(field);
    if (v !== undefined && v !== null && v !== '' && Number.isNaN(Number(v))) {
      this.addError(field, 'Must be a number.');
    }
    return this;
  }

  integer(field) {
    const v = this.value(field);
    if (v !== undefined && v !== null && v !== '' && !Number.isInteger(Number(v))) {
      this.addError(field, 'Must be an integer.');
    }
    return this;
  }

  minValue(field, min) {
    const v = this.value(field);
    if (v !== undefined && v !== null && v !== '' && Number(v) < min) {
      this.addError(field, `Must be at least ${min}.`);
    }
    return this;
  }

  in(field, allowed) {
    const v = this.value(field);
    if (v !== undefined && v !== null && v !== '' && !allowed.includes(v)) {
      this.addError(field, `Must be one of: ${allowed.join(', ')}`);
    }
    return this;
  }

  regex(field, pattern, message) {
    const v = this.value(field);
    if (v !== undefined && v !== null && v !== '' && !pattern.test(String(v))) {
      this.addError(field, message);
    }
    return this;
  }

  /**
   * 8+ chars, at least one letter and one digit. Not demanding special
   * characters on top of that — it just pushes users toward predictable
   * substitutions like "Passw0rd!".
   */
  strongPassword(field) {
    const v = this.value(field);
    if (v !== undefined && v !== null && v !== '') {
      const s = String(v);
      if (s.length < 8) {
        this.addError(field, 'Password must be at least 8 characters.');
      } else if (!/[A-Za-z]/.test(s) || !/\d/.test(s)) {
        this.addError(field, 'Password must contain at least one letter and one number.');
      }
    }
    return this;
  }
}

module.exports = { Validator };
