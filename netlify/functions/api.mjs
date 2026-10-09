/**
 * Follow-Up Tracker — Netlify Function (API)
 *
 * Handles every request to /api/* and stores data in Netlify Blobs
 * (built into Netlify, no database setup needed).
 *
 * Environment variable (set in Netlify → Project configuration → Environment variables):
 *   APP_PASSWORD   the password that unlocks the dashboard (required)
 *
 * API (all routes require  Authorization: Bearer <APP_PASSWORD>):
 *   GET    /api/auth/check
 *   GET    /api/data                 -> { profiles, contacts }
 *   GET    /api/export               -> full JSON backup
 *   POST   /api/profiles             { name, email, color }
 *   PUT    /api/profiles/:id         partial
 *   DELETE /api/profiles/:id         (also deletes its contacts)
 *   POST   /api/contacts             { profile_id, client_email, client_name, subject,
 *                                      next_followup, notes, cadence_days }
 *   PUT    /api/contacts/:id         partial; { log_sent: true } increments the counter
 *   DELETE /api/contacts/:id
 *
 * Storage layout: one JSON blob per record, under "profiles/<id>" and "contacts/<id>".
 */

import { getStore } from '@netlify/blobs';
import { createHash, timingSafeEqual } from 'node:crypto';

export const config = { path: '/api/*' };

const LIMITS = { name: 120, email: 254, subject: 300, notes: 20000, body: 100_000 };
const COLORS = ['indigo', 'sky', 'emerald', 'violet', 'rose', 'amber', 'teal', 'slate'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export default async function handler(request) {
  try {
    const password = process.env.APP_PASSWORD;
    const store = getStore({ name: 'followup-tracker', consistency: 'strong' });
    return await handleApi(request, store, password);
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    console.error('Unhandled API error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
}

/* ------------------------------------------------------------------ */
/* Router (exported separately so it can be tested with a mock store)  */
/* ------------------------------------------------------------------ */

export async function handleApi(request, store, password) {
  if (!password) {
    throw new HttpError(500, 'APP_PASSWORD is not set. Add it in Netlify environment variables, then redeploy.');
  }
  requireAuth(request, password);

  const db = new Db(store);
  const url = new URL(request.url);
  const method = request.method;
  const [resource, rawId] = url.pathname.split('/').filter(Boolean).slice(1);

  if (resource === 'auth' && rawId === 'check' && method === 'GET') return json({ ok: true });

  if ((resource === 'data' || resource === 'export') && !rawId && method === 'GET') {
    const [profiles, contacts] = await Promise.all([db.all('profiles'), db.all('contacts')]);
    profiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    contacts.sort((a, b) => a.next_followup.localeCompare(b.next_followup) || a.id - b.id);
    const payload = { profiles, contacts };
    if (resource === 'export') {
      payload.exported_at = new Date().toISOString();
      return json(payload, 200, {
        'Content-Disposition': `attachment; filename="followup-tracker-${payload.exported_at.slice(0, 10)}.json"`,
      });
    }
    return json(payload);
  }

  if (resource === 'profiles') {
    if (!rawId && method === 'POST') return createProfile(request, db);
    if (rawId) {
      const id = parseId(rawId);
      if (method === 'PUT' || method === 'PATCH') return updateProfile(request, db, id);
      if (method === 'DELETE') return deleteProfile(db, id);
    }
  }

  if (resource === 'contacts') {
    if (!rawId && method === 'POST') return createContact(request, db);
    if (rawId) {
      const id = parseId(rawId);
      if (method === 'PUT' || method === 'PATCH') return updateContact(request, db, id);
      if (method === 'DELETE') return deleteContact(db, id);
    }
  }

  throw new HttpError(404, `No route for ${method} ${url.pathname}`);
}

/* ------------------------------------------------------------------ */
/* Storage helper                                                      */
/* ------------------------------------------------------------------ */

class Db {
  constructor(store) {
    this.store = store;
  }
  async all(kind) {
    const { blobs } = await this.store.list({ prefix: `${kind}/` });
    const rows = await Promise.all(blobs.map((b) => this.store.get(b.key, { type: 'json' })));
    return rows.filter(Boolean);
  }
  get(kind, id) {
    return this.store.get(`${kind}/${id}`, { type: 'json' });
  }
  async put(kind, row) {
    await this.store.setJSON(`${kind}/${row.id}`, row);
    return row;
  }
  delete(kind, id) {
    return this.store.delete(`${kind}/${id}`);
  }
}

// Numeric, time-ordered, collision-resistant ids (fit safely in a JS number).
function newId() {
  return Date.now() * 1000 + Math.floor(Math.random() * 1000);
}

function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

/* ------------------------------------------------------------------ */
/* Profiles                                                            */
/* ------------------------------------------------------------------ */

async function createProfile(request, db) {
  const body = await readJson(request);
  const ts = now();
  const row = {
    id: newId(),
    name: vText(body.name, 'Profile name', LIMITS.name, { required: true }),
    email: vEmail(body.email, 'Mailbox address'),
    color: vColor(body.color),
    created_at: ts,
    updated_at: ts,
  };
  return json(await db.put('profiles', row), 201);
}

async function updateProfile(request, db, id) {
  const body = await readJson(request);
  const row = await db.get('profiles', id);
  if (!row) throw new HttpError(404, 'Profile not found.');

  let changed = false;
  if ('name' in body) { row.name = vText(body.name, 'Profile name', LIMITS.name, { required: true }); changed = true; }
  if ('email' in body) { row.email = vEmail(body.email, 'Mailbox address'); changed = true; }
  if ('color' in body) { row.color = vColor(body.color); changed = true; }
  if (!changed) throw new HttpError(400, 'Nothing to update.');

  row.updated_at = now();
  return json(await db.put('profiles', row));
}

async function deleteProfile(db, id) {
  const row = await db.get('profiles', id);
  if (!row) throw new HttpError(404, 'Profile not found.');
  const contacts = (await db.all('contacts')).filter((c) => c.profile_id === id);
  await Promise.all(contacts.map((c) => db.delete('contacts', c.id)));
  await db.delete('profiles', id);
  return json({ ok: true, deleted_contacts: contacts.length });
}

/* ------------------------------------------------------------------ */
/* Contacts (client emails that need follow-ups)                       */
/* ------------------------------------------------------------------ */

async function createContact(request, db) {
  const body = await readJson(request);
  const profileId = vInt(body.profile_id, 'Profile', 1, Number.MAX_SAFE_INTEGER);
  await ensureProfile(db, profileId);

  const ts = now();
  const row = {
    id: newId(),
    profile_id: profileId,
    client_name: vText(body.client_name, 'Client name', LIMITS.name),
    client_email: vEmail(body.client_email, 'Client email'),
    subject: vText(body.subject, 'Subject', LIMITS.subject),
    next_followup: vDate(body.next_followup, 'Next follow-up date'),
    notes: vText(body.notes, 'Notes', LIMITS.notes, { trim: false }),
    cadence_days: body.cadence_days === undefined ? 3 : vInt(body.cadence_days, 'Cadence', 1, 365),
    status: 'active',
    followup_count: 0,
    last_contacted: null,
    created_at: ts,
    updated_at: ts,
  };
  return json(await db.put('contacts', row), 201);
}

async function updateContact(request, db, id) {
  const body = await readJson(request);
  const row = await db.get('contacts', id);
  if (!row) throw new HttpError(404, 'Follow-up not found.');

  let changed = false;
  const set = (key, value) => { row[key] = value; changed = true; };

  if ('profile_id' in body) {
    const profileId = vInt(body.profile_id, 'Profile', 1, Number.MAX_SAFE_INTEGER);
    await ensureProfile(db, profileId);
    set('profile_id', profileId);
  }
  if ('client_name' in body) set('client_name', vText(body.client_name, 'Client name', LIMITS.name));
  if ('client_email' in body) set('client_email', vEmail(body.client_email, 'Client email'));
  if ('subject' in body) set('subject', vText(body.subject, 'Subject', LIMITS.subject));
  if ('next_followup' in body) set('next_followup', vDate(body.next_followup, 'Next follow-up date'));
  if ('notes' in body) set('notes', vText(body.notes, 'Notes', LIMITS.notes, { trim: false }));
  if ('cadence_days' in body) set('cadence_days', vInt(body.cadence_days, 'Cadence', 1, 365));
  if ('last_contacted' in body) {
    set('last_contacted', body.last_contacted === null ? null : vDate(body.last_contacted, 'Last contacted'));
  }
  if ('status' in body) {
    if (body.status !== 'active' && body.status !== 'archived') {
      throw new HttpError(400, 'Status must be "active" or "archived".');
    }
    set('status', body.status);
  }
  if (body.log_sent === true) set('followup_count', (row.followup_count || 0) + 1);
  if (!changed) throw new HttpError(400, 'Nothing to update.');

  row.updated_at = now();
  return json(await db.put('contacts', row));
}

async function deleteContact(db, id) {
  const row = await db.get('contacts', id);
  if (!row) throw new HttpError(404, 'Follow-up not found.');
  await db.delete('contacts', id);
  return json({ ok: true });
}

async function ensureProfile(db, id) {
  if (!(await db.get('profiles', id))) throw new HttpError(400, 'That profile does not exist.');
}

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

function requireAuth(request, password) {
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  // Hash both sides so the comparison is constant-time regardless of length.
  const a = createHash('sha256').update(token).digest();
  const b = createHash('sha256').update(password).digest();
  if (!token || !timingSafeEqual(a, b)) throw new HttpError(401, 'Wrong password.');
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > LIMITS.body) throw new HttpError(413, 'Request body is too large.');
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Request body must be a JSON object.');
  }
  return body;
}

function parseId(raw) {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id < 1) throw new HttpError(400, 'Invalid id.');
  return id;
}

function vText(v, field, max, { required = false, trim = true } = {}) {
  if (v === undefined || v === null) {
    if (required) throw new HttpError(400, `${field} is required.`);
    return '';
  }
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be text.`);
  const s = trim ? v.trim() : v;
  if (required && !s.trim()) throw new HttpError(400, `${field} is required.`);
  if (s.length > max) throw new HttpError(400, `${field} must be ${max} characters or fewer.`);
  return s;
}

function vEmail(v, field) {
  const s = vText(v, field, LIMITS.email, { required: true });
  if (!EMAIL_RE.test(s)) throw new HttpError(400, `${field} is not a valid email address.`);
  return s.toLowerCase();
}

function vDate(v, field) {
  if (typeof v !== 'string' || !DATE_RE.test(v)) {
    throw new HttpError(400, `${field} must be a date in YYYY-MM-DD format.`);
  }
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
    throw new HttpError(400, `${field} is not a real calendar date.`);
  }
  return v;
}

function vInt(v, field, min, max) {
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(400, `${field} must be a whole number between ${min} and ${max}.`);
  }
  return n;
}

function vColor(v) {
  return COLORS.includes(v) ? v : 'indigo';
}
