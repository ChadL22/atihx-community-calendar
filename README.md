# ATIHx Community Calendar

Community-organized ATIHx gatherings in one place. Browse by community, then add the calendars to your own so you never miss one.

A community-built project from the ATIHx Philadelphia and Washington, D.C. communities. **Not an official All Tech Is Human site.** For ATIH's own programs and events, visit [alltechishuman.org](https://alltechishuman.org/).

## How events get on the calendar

There are two ways, and both end up on the same calendar and in the same subscribed feeds.

**1. Automatically, from Luma.** Every "Add An Event" button sends people to the All Tech Is Human calendar on Luma (https://luma.com/AllTechIsHuman). There, the **Submit Event** button lets them create a new event, submit an existing Luma event, or submit an external one (Eventbrite, etc.). Once the calendar's admins accept it, it appears here within about an hour. No API key is needed:

- `.github/workflows/sync-luma.yml` runs `scripts/sync_luma.py` every hour on GitHub.
- The script reads the Luma calendar's public event list and keeps only events that physically take place in one of our communities:
  - with map coordinates: within 40 km of the community's center (the DC area, including Arlington and Bethesda; the Philadelphia area, including King of Prussia);
  - with a hidden, guests-only address: the city and state must match exactly (Washington, DC or Philadelphia, PA).
- Online events and events anywhere else are skipped, whatever their title says. You can change the centers, the radius and the place names in each community's `luma` block in `data/events.json`.
- It adds new events, refreshes ones that changed on Luma, removes ones taken down on Luma, then rebuilds the site files and publishes.
- To run it right away, go to the repo's **Actions** tab → **Sync events from Luma** → **Run workflow**.

Synced events are marked `"synced": true`. If you rewrite one's host or description by hand, your wording is kept.

**2. By hand, for anything else** (events shared in Slack, Eventbrite, university pages and so on). Add them to `data/events.json` as described under "Adding events by hand" below. The Luma sync never edits or removes hand-added events. If one of them later shows up on Luma (same link, or same date and title), the hand-added version is kept and no duplicate is created.

`submit.html` and the Cloudflare backend in `backend/` are kept for later but aren't linked from the site right now.

**Heads-up:** the sync commits to GitHub on its own, so run `git pull` before you push your own changes.

## What's in this folder

```
index.html            The calendar
submit.html           Submit-an-event form
css/styles.css        All styling
js/config.js          ← Backend address + Turnstile key (fill in after setup)
js/app.js             Calendar, community filter, subscribe panel, photo slideshow
js/submit.js          Submit form logic
assets/img/           Logo and slideshow photos
.nojekyll             Tells GitHub Pages to serve the files as-is

backend/              Cloudflare Worker + D1 database (see backend/SETUP.md)
  src/                API code
  public/admin/       Review page for admins and community leads
  schema.sql          Database tables
  test/               Automated tests and a no-install local server

data/events.json      All events (synced from Luma + added by hand)
data/events.js,       Generated from events.json by scripts/build.py
calendars/*.ics
scripts/sync_luma.py  Hourly Luma sync (run by .github/workflows/sync-luma.yml)
```

The website itself is plain HTML, CSS and JavaScript: no frameworks and no build step.

## Preview it on your computer

Double-click `index.html`, or for a closer match to the live site run a tiny local server from this folder:

```
python3 -m http.server 8000
```

then open http://localhost:8000.

The "Subscribe" buttons only work once the site is online, because Google Calendar, Apple Calendar and Outlook need a public web address to pull the feed from.

## Adding events by hand

1. Open `data/events.json` and add, change or remove events. Each event looks like this:

   ```json
   {
     "id": "philly-2026-11-05",
     "community": "philly",
     "title": "Monthly Meetup",
     "start": "2026-11-05T18:30",
     "end": "2026-11-05T20:30",
     "timezone": "America/New_York",
     "venue": "Venue name",
     "address": "Street address, Philadelphia, PA",
     "host": "ATIHx Philly with Code for Philly",
     "url": "https://link-to-rsvp-or-details",
     "description": "Optional details shown in subscribers' calendars."
   }
   ```

   - `id` must be unique and should never change once published. Calendar apps use it to update an event instead of duplicating it.
   - `community` must match one of the community `id`s at the top of the file.
   - `start`/`end` are local times for that community, written `YYYY-MM-DDTHH:MM`.
   - `url` is optional. When set, the event title links to it.

2. Run the build script from this folder:

   ```
   python3 scripts/build.py
   ```

3. Commit and push. Subscribers' calendars pick up changes the next time they refresh. Google Calendar can take up to a day; Apple and Outlook are usually faster.

For a Luma event that isn't on the All Tech Is Human calendar, use `luma-<the code at the end of the link>` as the `id` and the Luma link as `url`.

## Adding a community

**With the backend live:** an admin adds it on the review page under "Add a community". It appears in the filter, legend and feeds right away.

**Static fallback:** add an entry to the `communities` list in `data/events.json`:

```json
{ "id": "boston", "name": "Boston/Cambridge, MA", "short": "Boston", "color": "#8a6cff", "search": "boston cambridge massachusetts ma" }
```

- `id` is short and lowercase. It's used in feed file names (`calendars/boston.ics`).
- `search` holds extra words people might type in the filter box.
- Pick a `color` that's easy to tell apart from the others, with dark text readable on top of it.

Then run `python3 scripts/build.py`. The filter, legend and feeds update automatically. Up to 5 communities, the build also makes combined feeds such as `dc+philly.ics`; beyond that it makes one feed per community, and the page offers each selected community's feed separately.

## Swapping the slideshow photos

Put new photos in `assets/img/`, then edit the `<img>` tags inside `<figure class="carousel">` in `index.html`. Each photo needs:

- `src`: the file path
- `alt`: a short description of the photo
- `data-city`: the caption shown under the photo

Landscape photos around 4:3 fit the frame best. Add or remove as many `<img>` tags as you like; the dots update automatically.

## Publishing on GitHub Pages

1. Create a new repository on GitHub and push this folder to it.
2. In the repo, go to **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**, pick `main` and `/ (root)`, and save.
4. After a minute the site is live at `https://<your-username>.github.io/<repo-name>/`.

The subscribe links build themselves from the page's address, so nothing needs changing for a custom domain later.

With the backend connected, the subscribe links point at the Worker (`…workers.dev/calendars/all.ics`), which always serves the latest approved events.
