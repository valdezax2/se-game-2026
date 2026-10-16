import { ROOM_LIMITS, DIFFICULTIES } from '../shared/config.js';

const NAME_RE = /^[A-Za-z][A-Za-z'\- ]{0,39}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ZIP_RE = /^\d{5}(-\d{4})?$/; // US format
const DOB_RE = /^\d{4}-\d{2}-\d{2}$/;
const PHONE_CHARS_RE = /^[\d\s()+\-.]+$/;

const clean = (v) => String(v ?? '').trim();

function validDob(s) {
  if (!DOB_RE.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return null;
  if (d > new Date() || d.getUTCFullYear() < 1900) return null;
  return s;
}

// Returns { errors } or { value } with trimmed, normalised fields.
export function validateRegistration(body = {}) {
  const f = {
    firstName: clean(body.firstName),
    lastName: clean(body.lastName),
    phone: clean(body.phone),
    email: clean(body.email).toLowerCase(),
    zip: clean(body.zip),
    dob: clean(body.dob),
    password: String(body.password ?? ''),
  };

  const errors = [];
  if (!NAME_RE.test(f.firstName)) errors.push('First name: letters only, up to 40 characters.');
  if (!NAME_RE.test(f.lastName)) errors.push('Last name: letters only, up to 40 characters.');

  const digits = f.phone.replace(/\D/g, '');
  if (!PHONE_CHARS_RE.test(f.phone) || digits.length < 10 || digits.length > 15) {
    errors.push('Phone number: 10 to 15 digits.');
  }
  if (f.email.length > 120 || !EMAIL_RE.test(f.email)) errors.push('Email address looks invalid.');
  if (!ZIP_RE.test(f.zip)) errors.push('Zip code: 5 digits (US format).');
  if (!validDob(f.dob)) errors.push('Date of birth: use a real date in the past.');
  if (f.password.length < 8 || f.password.length > 128) errors.push('Password: 8 to 128 characters.');

  return errors.length ? { errors } : { value: f };
}

// Returns { errors } or { value } for a new room.
export function validateRoomConfig(body = {}) {
  const errors = [];
  const { totalMin, totalMax, nameMax, passwordMin, passwordMax } = ROOM_LIMITS;

  const name = clean(body.name).replace(/[<>&"']/g, '');
  if (!name || name.length > nameMax) errors.push(`Room name: 1 to ${nameMax} characters.`);

  const totalSlots = Number(body.totalSlots);
  if (!Number.isInteger(totalSlots) || totalSlots < totalMin || totalSlots > totalMax) {
    errors.push(`Total players (including CPUs): ${totalMin} to ${totalMax}.`);
  }

  // Human slots default to the total. A smaller number leaves the rest for CPUs.
  const rawHuman = body.humanSlots === undefined || body.humanSlots === '' ? totalSlots : Number(body.humanSlots);
  const humanSlots = rawHuman;
  if (!Number.isInteger(humanSlots) || humanSlots < 1 || humanSlots > totalSlots) {
    errors.push('Human slots: at least 1, and no more than the total players.');
  }

  const difficulty = body.difficulty ?? 'medium';
  if (!DIFFICULTIES.includes(difficulty)) errors.push('CPU difficulty: easy, medium or hard.');

  const visibility = body.visibility ?? 'public';
  if (visibility !== 'public' && visibility !== 'private') errors.push('Visibility: public or private.');

  const password = String(body.password ?? '');
  if (visibility === 'private' && (password.length < passwordMin || password.length > passwordMax)) {
    errors.push(`Password-protected rooms need a password of ${passwordMin} to ${passwordMax} characters.`);
  }

  if (errors.length) return { errors };
  return {
    value: {
      name,
      totalSlots,
      humanSlots,
      difficulty,
      visibility,
      password: visibility === 'private' ? password : '',
    },
  };
}
