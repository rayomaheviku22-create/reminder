# Follow-Up Tracker (Netlify)

A private dashboard for manually tracking email follow-ups across several support mailboxes. You log clients, dates and notes yourself, then copy your notes into Hostinger webmail when it's time to reply.

Runs entirely on Netlify's free plan: the page is static hosting, the server code is a Netlify Function, and the data lives in Netlify Blobs (built in, no database to set up).

## Files

```
netlify.toml                 Tells Netlify where the page and the server code are
package.json                 Installs the Netlify Blobs library
netlify/functions/api.mjs    The API: saves and loads profiles, follow-ups and notes
public/index.html            The dashboard page
```

## Deploy

**1. Upload to GitHub.** Unzip, select everything inside the folder, and drag it onto your repository's *Add file → Upload files* page. Commit. The front page of the repo must show `netlify.toml`, `package.json`, `netlify/` and `public/`. Files left over from the Cloudflare version (`src`, `dist`, `scripts`, `wrangler.jsonc`, `schema.sql`) are ignored and can be deleted whenever you like.

**2. Deploy on Netlify.** If the repository is already connected to a Netlify project, it redeploys automatically. Otherwise go to *Add new project → Import an existing project → GitHub*, pick the repository, leave every build setting as Netlify fills it in (the `netlify.toml` file sets them), and click *Deploy*.

**3. Set your password.** In the project, open *Project configuration → Environment variables → Add a variable*. Key: `APP_PASSWORD`. Value: a long password only you know. Save.

**4. Redeploy so the password takes effect.** Go to *Deploys → Trigger deploy → Deploy project*.

**5. Open the site** (the `*.netlify.app` link) and sign in.

Every commit to GitHub redeploys automatically. Your data is kept in Netlify Blobs and is not affected by redeploys. Never put your password in any file in the repository.

## Using the dashboard

- **Support profiles** (left sidebar): one per mailbox you send from. Click **Add**, or click a selected profile again (or hover and click **Edit** on desktop) to rename, recolour or delete it. Deleting a profile deletes its follow-ups.
- **New follow-up** (or press `n`): client email, optional name and subject, next follow-up date, how many days to wait after each sent email, and notes.
- **Urgency strip**: Overdue and Today are red, Tomorrow is yellow, later days are green. Click a cell to filter; click again to clear.
- **Snooze +1 day / +3 days / +1 week**: overdue items snooze from today; others push their current date out.
- **Mark sent**: records today as "last sent", counts the follow-up, and schedules the next one by the item's cadence.
- **Notes** save automatically. **Copy notes** and **Copy address** put text on your clipboard for Hostinger webmail.
- **Archive** finished conversations; **Reopen** them from the *Archived* tab.
- **Export backup** downloads everything as JSON. Do this now and then.

"Today" uses your browser's local date, so colours match your timezone.

## If something goes wrong

- **"Page not found":** `netlify.toml` is missing from the top level of the repository, or the upload put everything inside an extra folder.
- **"APP_PASSWORD is not set":** add the environment variable (step 3), then redeploy (step 4).
- **"Wrong password" with the right password:** you changed the variable but didn't redeploy, or there's a stray space in the value.
- **Anything else:** open *Logs → Functions → api* in Netlify and check the latest error.

## Security

The API requires `Authorization: Bearer <APP_PASSWORD>` on every request and compares it in constant time. The password is remembered in your browser until you press **Lock**, so only sign in on devices you trust.
