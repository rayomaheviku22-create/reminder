/**
 * Follow-Up Tracker — Cloudflare Worker
 *
 * Serves the dashboard (via Workers Static Assets, or an embedded HTML string
 * in the single-file build) and a small JSON REST API backed by Cloudflare D1.
 *
 * Bindings:
 *   DB            D1 database (required)
 *   APP_PASSWORD  Secret used to unlock the dashboard (required)
 *   ASSETS        Static assets binding (only in the Wrangler project build)
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
 */

// Replaced with the full HTML by scripts/build-single-file.mjs for the Dashboard build.
const EMBEDDED_HTML = null;

const LIMITS = { name: 120, email: 254, subject: 300, notes: 20000, body: 100_000 };
const COLORS = ['indigo', 'sky', 'emerald', 'violet', 'rose', 'amber', 'teal', 'slate'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Tables are created automatically on the first API request, so there is no
// separate database setup step. Kept in sync with schema.sql.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT 'indigo',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    client_name TEXT NOT NULL DEFAULT '',
    client_email TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT '',
    next_followup TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    cadence_days INTEGER NOT NULL DEFAULT 3,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    followup_count INTEGER NOT NULL DEFAULT 0,
    last_contacted TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  'CREATE INDEX IF NOT EXISTS idx_contacts_profile ON contacts (profile_id)',
  'CREATE INDEX IF NOT EXISTS idx_contacts_due ON contacts (status, next_followup)',
];
let schemaReady = null;

function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql))).catch((err) => {
      schemaReady = null; // retry on the next request
      throw err;
    });
  }
  return schemaReady;
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        if (err instanceof HttpError) return json({ error: err.message }, err.status);
        console.error('Unhandled API error:', err && err.stack ? err.stack : err);
        return json({ error: 'Internal server error' }, 500);
      }
    }

    return serveFrontend(request, env, url);
  },
};

/* ------------------------------------------------------------------ */
/* Frontend                                                            */
/* ------------------------------------------------------------------ */

async function serveFrontend(request, env, url) {
  if (env.ASSETS) {
    return withHeaders(await env.ASSETS.fetch(request), SECURITY_HEADERS);
  }
  if (EMBEDDED_HTML) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405 });
    }
    if (url.pathname !== '/' && url.pathname !== '/index.html') {
      return new Response('Not found', { status: 404 });
    }
    return new Response(EMBEDDED_HTML, {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS },
    });
  }
  return new Response('Frontend is not configured. Deploy with the "assets" config or use the single-file build.', {
    status: 500,
  });
}

/* ------------------------------------------------------------------ */
/* API router                                                          */
/* ------------------------------------------------------------------ */

async function handleApi(request, env, url) {
  if (!env.DB) throw new HttpError(500, 'The D1 binding "DB" is missing. Add it in your Worker bindings.');
  await requireAuth(request, env);
  await ensureSchema(env);

  const method = request.method;
  const [resource, rawId] = url.pathname.split('/').filter(Boolean).slice(1);

  if (resource === 'auth' && rawId === 'check' && method === 'GET') {
    return json({ ok: true });
  }

  if ((resource === 'data' || resource === 'export') && !rawId && method === 'GET') {
    const [profiles, contacts] = await env.DB.batch([
      env.DB.prepare('SELECT * FROM profiles ORDER BY name COLLATE NOCASE'),
      env.DB.prepare('SELECT * FROM contacts ORDER BY next_followup, id'),
    ]);
    const payload = { profiles: profiles.results, contacts: contacts.results };
    if (resource === 'export') {
      payload.exported_at = new Date().toISOString();
      return json(payload, 200, {
        'Content-Disposition': `attachment; filename="followup-tracker-${payload.exported_at.slice(0, 10)}.json"`,
      });
    }
    return json(payload);
  }

  if (resource === 'profiles') {
    if (!rawId) {
      if (method === 'POST') return createProfile(request, env);
    } else {
      const id = parseId(rawId);
      if (method === 'PUT' || method === 'PATCH') return updateProfile(request, env, id);
      if (method === 'DELETE') return deleteProfile(env, id);
    }
  }

  if (resource === 'contacts') {
    if (!rawId) {
      if (method === 'POST') return createContact(request, env);
    } else {
      const id = parseId(rawId);
      if (method === 'PUT' || method === 'PATCH') return updateContact(request, env, id);
      if (method === 'DELETE') return deleteContact(env, id);
    }
  }

  throw new HttpError(404, `No route for ${method} ${url.pathname}`);
}

/* ------------------------------------------------------------------ */
/* Profiles                                                            */
/* ------------------------------------------------------------------ */

async function createProfile(request, env) {
  const body = await readJson(request);
  const name = vText(body.name, 'Profile name', LIMITS.name, { required: true });
  const email = vEmail(body.email, 'Mailbox address');
  const color = vColor(body.color);

  const row = await env.DB.prepare('INSERT INTO profiles (name, email, color) VALUES (?, ?, ?) RETURNING *')
    .bind(name, email, color)
    .first();
  return json(row, 201);
}

async function updateProfile(request, env, id) {
  const body = await readJson(request);
  const sets = [];
  const values = [];

  if ('name' in body) push(sets, values, 'name', vText(body.name, 'Profile name', LIMITS.name, { required: true }));
  if ('email' in body) push(sets, values, 'email', vEmail(body.email, 'Mailbox address'));
  if ('color' in body) push(sets, values, 'color', vColor(body.color));
  if (!sets.length) throw new HttpError(400, 'Nothing to update.');

  sets.push("updated_at = datetime('now')");
  const row = await env.DB.prepare(`UPDATE profiles SET ${sets.join(', ')} WHERE id = ? RETURNING *`)
    .bind(...values, id)
    .first();
  if (!row) throw new HttpError(404, 'Profile not found.');
  return json(row);
}

async function deleteProfile(env, id) {
  // Delete children explicitly so this works even if foreign keys are not enforced.
  const [contactsRes, profileRes] = await env.DB.batch([
    env.DB.prepare('DELETE FROM contacts WHERE profile_id = ?').bind(id),
    env.DB.prepare('DELETE FROM profiles WHERE id = ?').bind(id),
  ]);
  if (!profileRes.meta.changes) throw new HttpError(404, 'Profile not found.');
  return json({ ok: true, deleted_contacts: contactsRes.meta.changes });
}

/* ------------------------------------------------------------------ */
/* Contacts (client emails that need follow-ups)                       */
/* ------------------------------------------------------------------ */

async function createContact(request, env) {
  const body = await readJson(request);
  const profileId = vInt(body.profile_id, 'Profile', 1, Number.MAX_SAFE_INTEGER);
  await ensureProfile(env, profileId);

  const row = await env.DB.prepare(
    `INSERT INTO contacts
       (profile_id, client_name, client_email, subject, next_followup, notes, cadence_days)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`
  )
    .bind(
      profileId,
      vText(body.client_name, 'Client name', LIMITS.name),
      vEmail(body.client_email, 'Client email'),
      vText(body.subject, 'Subject', LIMITS.subject),
      vDate(body.next_followup, 'Next follow-up date'),
      vText(body.notes, 'Notes', LIMITS.notes, { trim: false }),
      body.cadence_days === undefined ? 3 : vInt(body.cadence_days, 'Cadence', 1, 365)
    )
    .first();
  return json(row, 201);
}

async function updateContact(request, env, id) {
  const body = await readJson(request);
  const sets = [];
  const values = [];

  if ('profile_id' in body) {
    const profileId = vInt(body.profile_id, 'Profile', 1, Number.MAX_SAFE_INTEGER);
    await ensureProfile(env, profileId);
    push(sets, values, 'profile_id', profileId);
  }
  if ('client_name' in body) push(sets, values, 'client_name', vText(body.client_name, 'Client name', LIMITS.name));
  if ('client_email' in body) push(sets, values, 'client_email', vEmail(body.client_email, 'Client email'));
  if ('subject' in body) push(sets, values, 'subject', vText(body.subject, 'Subject', LIMITS.subject));
  if ('next_followup' in body) push(sets, values, 'next_followup', vDate(body.next_followup, 'Next follow-up date'));
  if ('notes' in body) push(sets, values, 'notes', vText(body.notes, 'Notes', LIMITS.notes, { trim: false }));
  if ('cadence_days' in body) push(sets, values, 'cadence_days', vInt(body.cadence_days, 'Cadence', 1, 365));
  if ('last_contacted' in body) {
    push(sets, values, 'last_contacted', body.last_contacted === null ? null : vDate(body.last_contacted, 'Last contacted'));
  }
  if ('status' in body) {
    if (body.status !== 'active' && body.status !== 'archived') {
      throw new HttpError(400, 'Status must be "active" or "archived".');
    }
    push(sets, values, 'status', body.status);
  }
  if (body.log_sent === true) sets.push('followup_count = followup_count + 1');
  if (!sets.length) throw new HttpError(400, 'Nothing to update.');

  sets.push("updated_at = datetime('now')");
  const row = await env.DB.prepare(`UPDATE contacts SET ${sets.join(', ')} WHERE id = ? RETURNING *`)
    .bind(...values, id)
    .first();
  if (!row) throw new HttpError(404, 'Follow-up not found.');
  return json(row);
}

async function deleteContact(env, id) {
  const res = await env.DB.prepare('DELETE FROM contacts WHERE id = ?').bind(id).run();
  if (!res.meta.changes) throw new HttpError(404, 'Follow-up not found.');
  return json({ ok: true });
}

async function ensureProfile(env, id) {
  const row = await env.DB.prepare('SELECT id FROM profiles WHERE id = ?').bind(id).first();
  if (!row) throw new HttpError(400, 'That profile does not exist.');
}

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

async function requireAuth(request, env) {
  if (!env.APP_PASSWORD) {
    throw new HttpError(500, 'APP_PASSWORD is not set. Add it as a secret on this Worker.');
  }
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !(await safeEqual(token, env.APP_PASSWORD))) {
    throw new HttpError(401, 'Wrong password.');
  }
}

// Constant-time comparison (hash first so lengths always match).
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
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
      ...SECURITY_HEADERS,
      ...extraHeaders,
    },
  });
}

function withHeaders(response, headers) {
  const res = new Response(response.body, response);
  for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  return res;
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

function push(sets, values, column, value) {
  sets.push(`${column} = ?`);
  values.push(value);
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
