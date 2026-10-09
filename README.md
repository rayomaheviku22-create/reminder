# Follow-Up Tracker (Cloudflare Workers + D1)

A private dashboard for manually tracking email follow-ups across several support mailboxes. No inbox connection; you log clients, dates and notes yourself, then copy your notes into Hostinger webmail when it's time to reply.

## What's in the project

```
reminder/
├── wrangler.jsonc               Worker config: D1 binding + static assets
├── package.json                 npm scripts (dev, deploy)
├── schema.sql                   D1 tables (reference only; created automatically)
├── src/worker.js                API (D1) + serves the dashboard
├── public/index.html            Dashboard UI (Tailwind CDN + vanilla JS)
├── public/_headers              Security headers for the static page
├── scripts/build-single-file.mjs  Builds the Dashboard copy-paste version
├── dist/worker-single-file.js   Worker with the HTML embedded (copy-paste method)
└── .dev.vars.example            Local password for `wrangler dev`
```

Storage is **D1** (SQLite) rather than KV, because profiles and contacts are relational, need partial updates, and KV's eventual consistency can show stale data right after a save.

---

## Deploy from GitHub to Cloudflare (recommended)

**Step 1: Upload to GitHub the right way**

1. Create an empty GitHub repository (for example `reminder`).
2. Unzip the download. Open the `reminder` folder so you can see `src`, `public`, `wrangler.jsonc`, and the rest.
3. On GitHub, click **Add file → Upload files**.
4. Select **everything inside** the `reminder` folder (not the folder itself) and drag it onto the page. Folders keep their structure when dragged.
5. Click **Commit changes**.

Your repository's front page must look like this. If `wrangler.jsonc` is not on the front page, or you see `worker.js` loose at the top level, the upload went wrong; delete and redo it.

```
dist/
public/
scripts/
src/
README.md
package.json
schema.sql
wrangler.jsonc
```

**Step 2: Create the database**

1. In the Cloudflare dashboard go to **Storage & Databases → D1 SQL Database → Create**.
2. Name it `followup_tracker` and create it.
3. Copy its **Database ID** (a long code like `a1b2c3d4-...`).

**Step 3: Put the database ID in GitHub**

1. In your repository, open `wrangler.jsonc` and click the pencil icon.
2. Replace `PASTE_YOUR_DATABASE_ID_HERE` with your ID, keeping the quote marks.
3. Click **Commit changes**.

There is no need to run any SQL. The app creates its tables automatically on first use.

**Step 4: Connect the repository to Cloudflare**

1. Go to **Workers & Pages → Create → Import a repository** and connect your GitHub account.
2. Pick your repository.
3. Set the project name to `followup-tracker` (it must match `"name"` in `wrangler.jsonc`).
4. Leave the build command empty and the deploy command as `npx wrangler deploy`.
5. Click **Deploy** and wait for the build to finish.

**Step 5: Set your password**

1. Open the new Worker, go to **Settings → Variables and Secrets → Add**.
2. Type: **Secret**. Name: `APP_PASSWORD`. Value: a long password only you know.
3. Save. Open the `*.workers.dev` link on the Worker's overview page and sign in.

From now on, every change you commit to GitHub redeploys automatically. Never put your password in any file in the repository.

---

## Alternative: deploy without GitHub (copy and paste)

1. Create the D1 database as in Step 2 above.
2. Go to **Workers & Pages → Create → Create Worker**, name it, and click **Deploy**.
3. Click **Edit code**, delete everything, paste the full contents of `dist/worker-single-file.js`, and click **Deploy**.
4. In **Settings → Bindings → Add → D1 database**, use the variable name `DB` and pick `followup_tracker`.
5. Add the `APP_PASSWORD` secret as in Step 5 above, then open the link.

---

## Local development (optional, needs Node.js 18+)

```bash
npm install
cp .dev.vars.example .dev.vars     # set a local password inside
npm run dev                        # http://localhost:8787
```

---

## If something goes wrong

- **Build fails with "entry-point" or "could not resolve" errors:** the files are not in the right folders. Check the repository front page matches the layout in Step 1.
- **Build fails mentioning `database_id`:** the ID in `wrangler.jsonc` is missing or wrong.
- **Build fails about the Worker name:** the project name in Cloudflare must be `followup-tracker`, the same as in `wrangler.jsonc`.
- **Page loads but says APP_PASSWORD is not set:** add the secret (Step 5).
- **"The D1 binding DB is missing":** the database ID wasn't saved in `wrangler.jsonc`, or (copy-paste method) the binding isn't named exactly `DB`.

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
- **Backups.** Use the **Export backup** button. D1 also has Time Travel point-in-time restore (`npx wrangler d1 time-travel restore followup_tracker --timestamp=<ISO time>`).
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
