# Backend setup: Cloudflare

This folder is the calendar's backend: a Cloudflare **Worker** (the API), a **D1** database, **Turnstile** (the "I'm human" check on the submit form) and **Cloudflare Access** (sign-in for the review page).

Plan on about 30–45 minutes the first time. You need a free Cloudflare account and Node.js 18 or newer on your Mac (`node --version` to check).

> Cloudflare's dashboard changes from time to time, so button names below may differ slightly. The steps stay the same.

---

## How it fits together

```
GitHub Pages (the website)                       Cloudflare
 ├─ index.html  ── reads events ──────────────▶  Worker  /api/events
 ├─ add.html ──── "Add An Event" forms ───────▶  Worker  /api/luma-submissions ──▶ queue ──▶ Luma bot ──▶ ATIH calendar on Luma
 ├─ submit.html ── (older form, not linked) ──▶  Worker  /api/submissions
 └─ "Subscribe" buttons ──────────────────────▶  Worker  /calendars/all.ics, philly.ics, dc.ics …
                                                    │
 You + community leads ── sign in via Access ──▶  Worker  /admin  (review page)
                                                    │
                                                    ▼
                                                 D1 database
```

- **Submissions** land as *pending* (or go straight live if you turn on `AUTO_PUBLISH`).
- **Duplicates:** the database refuses a second event in the same community on the same day with the same title, ignoring capitals and punctuation. A different title on the same day still goes through, but is flagged for reviewers as a possible duplicate.
- **Leads** see and approve only their own community. **Admins** (you) see everything and manage the moderator list.

---

## 1. Install and sign in

Open Terminal and run:

```
cd ~/Desktop/"ATIH Community Cal"/backend
npm install
npx wrangler login
```

`wrangler login` opens your browser to connect to your Cloudflare account.

## 2. Create the database

```
npx wrangler d1 create atih-community-cal
```

It prints a `database_id`. Open `wrangler.toml` and paste it in place of `PASTE-YOUR-DATABASE-ID-HERE`. Then create the tables and the two starting communities:

```
npm run db:init
```

## 3. Set up Turnstile (the bot check)

1. In the Cloudflare dashboard, open **Turnstile → Add widget**.
2. Name it "ATIH Community Cal". For hostnames, add your GitHub Pages host (for example `chadl22.github.io`) and `localhost` for testing.
3. Choose **Managed** mode and create it.
4. Copy the **Site key** into `js/config.js` (the site's config, one folder up) as `turnstileSiteKey`. It's public, so it's safe to commit.
5. Save the **Secret key** to the Worker. It's never written in a file:

   ```
   npx wrangler secret put TURNSTILE_SECRET
   ```

   Paste the secret when asked.

6. Add a random value used to anonymize visitor IPs for rate limiting:

   ```
   npx wrangler secret put IP_HASH_SALT
   ```

   Paste any long random string (`openssl rand -hex 32` makes one).

## 4. Tell the Worker where your site lives

In `wrangler.toml`, set `ALLOWED_ORIGINS` to your GitHub Pages address with no trailing slash and no repo path:

```
ALLOWED_ORIGINS = "https://chadl22.github.io,http://localhost:8000"
```

## 5. Deploy

```
npm run deploy
```

Wrangler prints your Worker's address, something like `https://atih-community-cal.<your-subdomain>.workers.dev`. Put it in `js/config.js`:

```js
apiBase: 'https://atih-community-cal.<your-subdomain>.workers.dev',
```

Visit `<that address>/api/events` in your browser. You should see the two communities and an empty events list.

## 6. Protect the review page with Cloudflare Access

The review page (`/admin`) and its API (`/api/admin/*`) must sit behind Access. The Worker refuses admin requests without a valid Access sign-in, so this step is required.

1. In the Cloudflare dashboard, open **Zero Trust**. The first time, it asks you to pick a team name; the free plan is fine. Your **team domain** is `https://<team-name>.cloudflareaccess.com`.
2. Go to **Settings → Authentication** and make sure **One-time PIN** is enabled. People sign in with a code emailed to them, so no passwords are needed.
3. Go to **Access → Applications → Add an application → Self-hosted**.
   - **Name:** ATIH Community Cal review
   - **Destinations:** add two, both on your Worker's host (`atih-community-cal.<your-subdomain>.workers.dev`):
     path `admin` and path `api/admin`
   - **Policy:** Action *Allow*, Include *Everyone*. That sounds open, but signing in only proves who someone is. The Worker then lets in only people on the moderator list (step 7), so you manage reviewers in one place, the review page.
4. Save. Open the application again and copy its **Application Audience (AUD) Tag**.
5. In `wrangler.toml`, fill in:

   ```
   ACCESS_TEAM_DOMAIN = "https://<team-name>.cloudflareaccess.com"
   ACCESS_AUD = "<the AUD tag>"
   ```

6. Deploy again: `npm run deploy`.

## 7. Add yourself and the community leads

```
cp seed-moderators.example.sql seed-moderators.sql
```

Edit `seed-moderators.sql` with real email addresses: yours as `admin`, each lead as `lead` with their community. Then:

```
npx wrangler d1 execute atih-community-cal --remote --file=seed-moderators.sql
```

From now on you can add and remove leads, and add new communities, on the review page itself. `seed-moderators.sql` is git-ignored so emails don't end up on GitHub.

## 8. Publish the site and try it

1. Commit and push the whole folder (with the updated `js/config.js`) to GitHub.
2. Open `https://<your-site>/submit.html` and submit a test event.
3. Open `https://<your-worker>/admin/`, sign in with your email, and approve it.
4. Within about 30 seconds it appears on the calendar and in the subscribe feeds.

---

## 9. Sending events to Luma (the Luma bot)

The **Add An Event** page (`add.html`) offers three choices:

| Choice | What happens |
|---|---|
| A new Luma event | Opens Luma's create page, already set to the All Tech Is Human calendar. Nothing to set up. |
| An existing Luma event | Our form → the queue → the Luma bot submits it with **Submit Event → Submit Existing Luma Event**. |
| A non-Luma event | Our form → the queue → the Luma bot submits it with **Submit Event → Submit External Event**. |

Luma's admins accept or decline submissions as usual. Accepted in-person DMV and Philadelphia events reach our calendar through the hourly Luma sync (`scripts/sync_luma.py`).

**How the bot works:** every 2 minutes, if anything is waiting, the Worker starts a headless Chrome through Cloudflare **Browser Rendering**. It opens the ATIH calendar on Luma, signed in as the community's own Luma account, and fills in Luma's form the way a person would. The code is in `src/luma-bot.js`. It uses no browser time when the queue is empty.

**Before you start:** read Luma's terms of service (luma.com/terms) to make sure automated submissions from your account are OK. Also tell ATIH's calendar admins that submissions from this account come from the community site.

### 9a. Create the bot's Luma account

1. Make an email address just for this, e.g. a new Gmail like `atihx.community.calendar@gmail.com`.
2. Sign up at luma.com with it and name the account **ATIHx Community Calendar**, so ATIH's admins know where submissions come from.
3. Use a separate Chrome profile for it (Chrome menu → Profiles → Add), so you stay signed in to your own Luma account elsewhere.

### 9b. Give the bot its sign-in

Luma signs people in with an emailed code, so the bot can't sign itself in. Instead, it reuses the sign-in from your browser:

1. In the bot's Chrome profile, sign in at **luma.com** with the bot account.
2. Open Chrome's developer tools: **View → Developer → Developer Tools**.
3. Go to the **Application** tab → **Cookies** → `https://luma.com`.
4. Find the cookie named **`luma.auth-session-key`** and copy its **Value** (double-click the value, then Cmd+C).
   - If there's no cookie with that name, look for one with "auth" and "session" in its name. Put its name in `LUMA_COOKIE_NAME` in `wrangler.toml`.
5. In Terminal, from the `backend` folder:
   ```
   npx wrangler secret put LUMA_SESSION
   ```
   and paste the value when asked.
6. **Don't click "Sign out"** in that Chrome profile, because that ends the session the bot is using. Just close the window.

Treat this value like a password: it gives full access to the bot's Luma account. Never put it in a file or a chat.

### 9c. Turn it on

From the `backend` folder:

```
npm install                 # adds @cloudflare/puppeteer for the bot
npm run db:init             # adds the new tables (safe to re-run)
npm run deploy
```

`wrangler.toml` already contains the Browser Rendering connection (`browser = { binding = "BROWSER" }`) and the every-2-minutes schedule (`[triggers]`). Make sure `apiBase` and `turnstileSiteKey` are filled in in `js/config.js` (steps 3 and 8). Until then, the Add An Event page shows step-by-step Luma instructions instead of the forms.

### 9d. Try it

1. On the site, choose **An existing Luma event** and paste the link to an event you host on Luma.
2. On the review page (`/admin/`), the **Sent to Luma** panel shows it as *Waiting to send*. Within about 2 minutes it changes to *Sent to Luma*, or click **Run the bot now**.
3. Ask an ATIH calendar admin to confirm it arrived in their submissions.

### Keeping it running

- **Signed out:** Luma sign-ins eventually expire. When that happens, the bot stops and parks everything as *Waiting for sign-in*, and the panel turns red. Repeat step 9b to paste a fresh value, then click **Retry waiting and failed**. Nothing is lost.
- **Errors:** if Luma rejects something (a bad link, or an event that was already submitted), the bot tries 3 times, then marks it *Couldn't send* with the reason and the submitter's email so you can follow up.
- **When Luma changes its page:** the error names the step that failed (e.g. *couldn't pick the menu option: "Submit External Event" not found*). Update the matching step in `src/luma-bot.js`, then run `npm run test:bot`, which drives a real browser against a stand-in Luma page (`test/mock-luma.html`). Update the stand-in to match Luma's new page too.
- **Free plan limits:** Browser Rendering's free plan allows 10 minutes of browser time a day. At roughly 20–30 seconds per event, that's about 20 events a day. Beyond that, the $5/month Workers Paid plan removes the daily cap. Events past the limit just wait until the next day.

---

## Everyday use

- **Review page:** `https://<your-worker>/admin/`. Send this link to your community leads; it works on a phone too. Each event shows a **details check**: date and time, location, hosts and sponsors, and description are required, and the registration link is optional. From there a lead can **Approve and publish**, **Fix details** themselves, **Ask submitter** (opens an email listing exactly what's missing) or **Decline** with a quick reason. Publishing an event with missing details asks for confirmation first. Tabs show *To review*, *Published* and *Declined*. Admins can also delete events, manage reviewers and add communities.
- **What submitters must provide:** the submit form requires a location (venue or address), who's hosting or sponsoring, and a description of at least a sentence. The registration link (Luma, Eventbrite, Meetup…) is optional.
- **Auto-publish:** to let events go live without review, set `AUTO_PUBLISH = "true"` in `wrangler.toml` and run `npm run deploy`. The bot check, rate limit and duplicate guard still apply, and anything flagged as a possible duplicate still waits for a lead.
- **Rate limit:** each visitor can submit up to 5 events an hour.
- **Privacy:** submitter emails are visible only on the review page and never appear in the public API or feeds. IP addresses are stored only as salted hashes, and only for 24 hours.

## Working on it locally

**With Cloudflare's tools** (closest to production):

```
cp .dev.vars.example .dev.vars
npm run db:init:local
npm run dev
```

The API and review page run on http://localhost:8787 (review page at `/admin/`, signed in as the `DEV_ADMIN_EMAIL` in `.dev.vars`). In another Terminal window, serve the site with `python3 -m http.server 8000` from the main folder, and temporarily set `apiBase: 'http://localhost:8787'` in `js/config.js`.

**Without installing anything** (Node 22+):

```
node --experimental-sqlite test/dev-server.mjs
```

This does the same on port 8787 using a local SQLite file.

**Tests:** `npm test` runs 27 checks covering submissions, duplicates, rate limiting, lead permissions and Access sign-in verification. `npm run test:bot` runs the Luma bot end to end in a real browser against a stand-in Luma page (needs Playwright: `npx playwright install chromium` the first time).

## Costs

Cloudflare's free tiers for Workers, D1, Turnstile and Zero Trust (up to 50 users) have so far covered a project this size comfortably. The Luma bot's Browser Rendering is free up to 10 browser-minutes a day (about 20 events); the $5/month Workers Paid plan lifts that. Check current limits on Cloudflare's pricing pages before launch.

## Ideas for later

- Email leads when something new is waiting (Cloudflare Email Workers or a service like Resend).
- Let submitters edit their own event through a private link.
- A "report a problem" link on each event.
