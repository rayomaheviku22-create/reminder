# Follow-Up Tracker (Cloudflare Workers + D1)

A private dashboard for manually tracking email follow-ups across several support mailboxes. No inbox connection; you log clients, dates and notes yourself, then copy your notes into Hostinger webmail when it's time to reply.

## What's in the project

```
followup-tracker/
├── wrangler.jsonc               Worker config: D1 binding + static assets
├── package.json                 npm scripts (dev, deploy, db init, backup)
├── schema.sql                   D1 tables (profiles, contacts)
├── src/worker.js                API (D1) + serves the dashboard
├── public/index.html            Dashboard UI (Tailwind CDN + vanilla JS)
├── public/_headers              Security headers for the static page
├── scripts/build-single-file.mjs  Builds the Dashboard copy-paste version
├── dist/worker-single-file.js   Worker with the HTML embedded (for Option B)
└── .dev.vars.example            Local password for `wrangler dev`
```

Storage is **D1** (SQLite) rather than KV, because profiles and contacts are relational, need partial updates, and KV's eventual consistency can show stale data right after a save.

---

## Option A: Deploy with Wrangler (recommended)

You need Node.js 18+ and a Cloudflare account (the free plan is enough).

**1. Install and log in**

```bash
cd followup-tracker
npm install
npx wrangler login
```

**2. Create the D1 database**

```bash
npx wrangler d1 create followup_tracker
```

Copy the `database_id` it prints and paste it into `wrangler.jsonc`, replacing `REPLACE_WITH_YOUR_D1_DATABASE_ID`.

**3. Create the tables**

```bash
npm run db:init:remote
# same as: npx wrangler d1 execute followup_tracker --remote --file=./schema.sql
```

**4. Set your dashboard password** (stored as an encrypted secret, never in code)

```bash
npx wrangler secret put APP_PASSWORD
```

Use a long, unique password. You type it once per browser; it's remembered until you press **Lock**.

**5. Deploy**

```bash
npm run deploy
```

Wrangler prints your URL, e.g. `https://followup-tracker.<your-subdomain>.workers.dev`. Open it and sign in.

**Local development (optional)**

```bash
cp .dev.vars.example .dev.vars        # set a local password inside
npm run db:init:local
npm run dev                           # http://localhost:8787
```

---

## Option B: Deploy from the Cloudflare Dashboard (no CLI)

1. **Create the database.** Go to *Storage & Databases → D1 SQL Database → Create*. Name it `followup_tracker`.
2. **Create the tables.** Open the database, go to the *Console* tab, paste the contents of `schema.sql`, and run it.
3. **Create the Worker.** Go to *Workers & Pages → Create → Create Worker*, name it `followup-tracker`, and click *Deploy* (the hello-world code is fine for now).
4. **Paste the code.** Click *Edit code*, delete everything in `worker.js`, paste the full contents of `dist/worker-single-file.js`, and click *Deploy*.
5. **Bind the database.** In the Worker, go to *Settings → Bindings → Add → D1 database*. Variable name: `DB` (exactly). Database: `followup_tracker`.
6. **Add the password.** *Settings → Variables and Secrets → Add*. Type: **Secret**. Name: `APP_PASSWORD`. Value: your password.
7. Open the `*.workers.dev` URL shown on the Worker's overview page and sign in.

If you later change `src/worker.js` or `public/index.html`, run `npm run build:single` to regenerate the paste-in file.

---

## Using the dashboard

- **Support profiles** (left sidebar): one per mailbox you send from. Click **Add**, or click a selected profile again (or hover and click **Edit** on desktop) to rename, recolour or delete it. Deleting a profile deletes its follow-ups.
- **New follow-up** (or press `n`): client email, optional name and subject, the next follow-up date, how many days to wait after each sent email, and notes.
- **Urgency strip**: Overdue and Today are red, Tomorrow is yellow, later days are green. Click any cell to filter the list to that day; click again to clear.
- **Snooze +1 day / +3 days / +1 week**: one click. If the item is overdue, the snooze counts from today so it doesn't stay overdue; otherwise it pushes the current date out.
- **Mark sent**: records today as "last sent", adds one to the follow-up count, and reschedules the next reminder by the item's cadence.
- **Date picker** on each card: change the date manually anytime.
- **Notes** save automatically as you type. **Copy notes** puts them on your clipboard for pasting into Hostinger webmail; **Copy address** copies the client's email.
- **Archive** finished conversations; find them under the *Archived* tab and **Reopen** if needed.
- **Export backup** downloads everything as JSON.

"Today" is based on your browser's local date, so the colours are correct for your timezone.

---

## Security and production notes

- **Password gate.** Every API call requires `Authorization: Bearer <APP_PASSWORD>`, checked with a constant-time comparison. The password is kept in your browser's localStorage until you press **Lock**, so only use it on devices you trust.
- **Stronger protection (recommended).** Put the Worker behind **Cloudflare Access** (Zero Trust → Access → Applications → Self-hosted, add your workers.dev or custom domain, allow only your email). It's free for up to 50 users and adds one-time-PIN or Google login before the page even loads. Keep `APP_PASSWORD` as a second layer.
- **Custom domain.** Worker → *Settings → Domains & Routes → Add → Custom domain* (e.g. `followups.yourdomain.com`), if your domain is on Cloudflare.
- **Backups.** Use the **Export backup** button, or `npm run db:backup` to dump the D1 database to `backup.sql`. D1 also has Time Travel point-in-time restore (`npx wrangler d1 time-travel restore followup_tracker --timestamp=<ISO time>`).
- **Tailwind CDN.** The UI uses Tailwind's Play CDN as requested. It works well for a single-user tool; if you ever want zero third-party scripts, compile Tailwind once with the Tailwind CLI and inline the CSS.
- **Input limits.** The API validates emails, real calendar dates, field lengths (notes up to 20,000 characters) and request size (100 KB).

## API reference

All routes need `Authorization: Bearer <APP_PASSWORD>`.

| Method | Path | Body |
|---|---|---|
| GET | `/api/auth/check` | |
| GET | `/api/data` | returns `{ profiles, contacts }` |
| GET | `/api/export` | JSON backup download |
| POST | `/api/profiles` | `{ name, email, color }` |
| PUT | `/api/profiles/:id` | any of the above |
| DELETE | `/api/profiles/:id` | deletes its contacts too |
| POST | `/api/contacts` | `{ profile_id, client_email, client_name?, subject?, next_followup, notes?, cadence_days? }` |
| PUT | `/api/contacts/:id` | any field, plus `status` (`active`/`archived`), `last_contacted`, `log_sent: true` |
| DELETE | `/api/contacts/:id` | |

Dates are `YYYY-MM-DD`.
