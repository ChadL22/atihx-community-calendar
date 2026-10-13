#!/usr/bin/env python3
"""Pull accepted events from the All Tech Is Human calendar on Luma.

Anyone can submit an event to https://luma.com/AllTechIsHuman ("Submit Event").
Once the calendar's admins accept it, it shows up in the calendar's public
event list. This script reads that list (no API key needed), keeps the events
that belong to one of our communities, and updates data/events.json. It then
runs build.py so data/events.js and the calendar feeds match.

A GitHub Action runs it every hour (.github/workflows/sync-luma.yml). You can
also run it yourself from the project folder:

    python3 scripts/sync_luma.py

How an event is matched to a community (settings live in data/events.json,
under each community's "luma" block). Location is the only test:
  - Its city and state match one of its "places" (for DC that's the DMV:
    DC plus suburban Maryland and Northern Virginia), or
  - Luma's map location is within radius_km of the community's center.
Online events and events anywhere else are skipped, whatever the title says.

What the script changes:
  - Adds new matching events and marks them "synced": true.
  - Refreshes title, times, venue, address and link on synced events, so edits
    made on Luma show up here. If an event already has a host or description
    here, that text is kept, so hand-written wording isn't overwritten.
  - Removes synced events that are no longer on the Luma calendar (cancelled or
    taken down).
  - Never edits or removes events you added by hand (from Slack posts, etc.).
    If one of them later shows up on Luma (same link, or same date and title),
    the hand-added version is kept and no duplicate is created.
If Luma can't be reached or sends something unexpected, nothing is changed.

Uses only the Python standard library.
"""

import hashlib
import html
import json
import math
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "events.json"
API = "https://api.lu.ma"
# For testing: a folder of saved responses to read instead of calling Luma.
FIXTURES = os.environ.get("LUMA_FIXTURES")


class SyncError(Exception):
    pass


def get_json(path, params):
    query = urllib.parse.urlencode(params)
    if FIXTURES:
        name = re.sub(r"[^A-Za-z0-9_.-]+", "_", f"{path.strip('/')}_{query}") + ".json"
        file = Path(FIXTURES) / name
        if not file.exists():
            raise SyncError(f"missing fixture {name}")
        return json.loads(file.read_text())
    url = f"{API}{path}?{query}"
    req = urllib.request.Request(url, headers={
        "Accept": "application/json",
        "User-Agent": "ATIHx-Community-Calendar/1.0 (+https://github.com)",
    })
    last = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as err:  # network hiccup or rate limit: wait and retry
            last = err
            time.sleep(2 * (attempt + 1))
    raise SyncError(f"could not load {url}: {last}")


def calendar_entries(calendar_id, period):
    """Every accepted event on the calendar for 'future' or 'past'."""
    entries, cursor = [], None
    for _ in range(20):  # safety cap: 20 pages x 50 events
        params = {"calendar_api_id": calendar_id, "period": period, "pagination_limit": 50}
        if cursor:
            params["pagination_cursor"] = cursor
        page = get_json("/calendar/get-items", params)
        if not isinstance(page, dict) or not isinstance(page.get("entries"), list):
            raise SyncError(f"unexpected response for {period} events")
        entries.extend(page["entries"])
        cursor = page.get("next_cursor")
        if not page.get("has_more") or not cursor:
            break
    return entries


def description_for(event_api_id):
    """Plain-text description, trimmed to a few sentences. Empty if unavailable."""
    try:
        data = get_json("/event/get", {"event_api_id": event_api_id})
    except SyncError:
        return ""
    parts = []

    def walk(node):
        if isinstance(node, dict):
            if node.get("type") == "text":
                parts.append(node.get("text", ""))
            for child in node.get("content") or []:
                walk(child)
            if node.get("type") in ("paragraph", "heading", "list_item"):
                parts.append(" ")
        elif isinstance(node, list):
            for child in node:
                walk(child)

    walk(data.get("description_mirror"))
    text = re.sub(r"\s+", " ", html.unescape("".join(parts))).strip()
    if len(text) <= 500:
        return text
    cut = text[:500]
    end = max(cut.rfind(". "), cut.rfind("! "), cut.rfind("? "))
    return (cut[: end + 1] if end > 200 else cut.rsplit(" ", 1)[0] + "…").strip()


def km_between(a, b):
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))


def coordinate_of(event):
    for c in (event.get("coordinate"), (event.get("geo_address_info") or {}).get("place_coordinate")):
        if isinstance(c, dict) and c.get("latitude") is not None and c.get("longitude") is not None:
            return (float(c["latitude"]), float(c["longitude"]))
    return None


def match_community(event, communities):
    """Return the community this event physically takes place in, or None.

    Location is the only thing that counts: online events and events elsewhere
    never match, whatever their title says.
      - Its city AND state match one of the community's places exactly,
        e.g. Philadelphia, PA or Arlington, VA (not Arlington, TX), or
      - Luma has map coordinates within radius_km of the community's center.
    """
    if event.get("location_type") == "online":
        return None
    geo = event.get("geo_address_info") or {}
    point = coordinate_of(event)
    city = (geo.get("city") or "").strip().lower()
    region = {(geo.get("region") or "").strip().lower(), (geo.get("region_short") or "").strip().lower()}
    if geo.get("city_state"):  # e.g. "Philadelphia, PA"
        cs_city, _, cs_region = geo["city_state"].partition(",")
        city = city or cs_city.strip().lower()
        region.add(cs_region.strip().lower())
    region.discard("")
    for c in communities:
        rules = c.get("luma") or {}
        # A listed city in the right state always counts (e.g. Leesburg, VA).
        for place in rules.get("places", []):
            names = [n.lower() for n in place.get("cities", [])] + ([place["city"].lower()] if place.get("city") else [])
            if city in names and region & {r.lower() for r in place["regions"]}:
                return c["id"]
        # Otherwise use the map location, when Luma has one.
        center = rules.get("center")
        if point and center and km_between(point, (center["lat"], center["lng"])) <= rules.get("radius_km", 40):
            return c["id"]
    return None


def normalize(title):
    return re.sub(r"[^a-z0-9]+", " ", (title or "").lower()).strip()


def local_time(iso, tz):
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(ZoneInfo(tz)).strftime("%Y-%m-%dT%H:%M")


def where(event):
    geo = event.get("geo_address_info") or {}
    if event.get("location_type") == "online":
        return "Online", ""
    if geo.get("mode") == "obfuscated" or not geo.get("full_address"):
        area = geo.get("sublocality") or geo.get("city") or ""
        city = geo.get("city_state") or geo.get("city") or ""
        return area or city or "Location shared with registered guests", (
            f"{city} (exact address shared with registered guests)" if city else "")
    venue = (geo.get("address") or "").strip()
    address = re.sub(r",\s*(USA|United States)$", "", geo["full_address"].strip())
    if venue and address.startswith(venue + ","):
        address = address[len(venue) + 1:].strip()
    elif not venue or re.match(r"^\d", venue):  # Luma's "address" is a street, not a venue name
        venue = geo.get("short_address") or venue
    return venue, address


def to_event(entry, community):
    ev = entry["event"]
    tz = ev.get("timezone") or "America/New_York"
    venue, address = where(ev)
    hosts = [h.get("name") for h in entry.get("hosts") or [] if h.get("name")]
    link = ev["url"]
    if link.startswith("http"):  # an external event submitted to the calendar
        event_id, url = f"luma-ext-{ev.get('api_id') or hashlib.sha1(link.encode()).hexdigest()[:12]}", link
    else:
        event_id, url = f"luma-{link}", f"https://luma.com/{link}"
    return {
        "id": event_id,
        "community": community,
        "title": ev["name"].strip(),
        "start": local_time(ev["start_at"], tz),
        "end": local_time(ev["end_at"], tz) if ev.get("end_at") else None,
        "timezone": tz,
        "venue": venue,
        "address": address,
        "host": ", ".join(hosts),
        "url": url,
        "description": None,  # filled in only when needed (one extra request per event)
        "source": "luma",
        "synced": True,
    }


def main():
    data = json.loads(DATA.read_text())
    settings = data.get("luma") or {}
    calendar_id = settings.get("calendar_api_id")
    if not calendar_id:
        sys.exit("No luma.calendar_api_id in data/events.json")
    communities = data["communities"]

    try:
        entries = calendar_entries(calendar_id, "future") + calendar_entries(calendar_id, "past")
    except SyncError as err:
        sys.exit(f"Luma sync skipped, nothing changed: {err}")

    found = {}
    for entry in entries:
        ev = entry.get("event") or {}
        if entry.get("status", "approved") != "approved" or not ev.get("url") or not ev.get("start_at"):
            continue
        community = match_community(ev, communities)
        if community:
            item = to_event(entry, community)
            item["_api_id"] = ev.get("api_id")
            found[item["id"]] = item

    events = data["events"]
    by_id = {e["id"]: e for e in events}
    added, updated, removed = [], [], []

    for item in found.values():
        api_id = item.pop("_api_id")
        current = by_id.get(item["id"])
        if current is None:
            twin = next((e for e in events if not e.get("synced") and (
                (e.get("url") or "").rstrip("/").lower() == item["url"].lower()
                or (e["start"][:10] == item["start"][:10] and normalize(e["title"]) == normalize(item["title"])))), None)
            if twin:  # already added by hand (e.g. from a Slack post): leave it alone
                continue
            item["description"] = description_for(api_id) if api_id else ""
            events.append({k: v for k, v in item.items() if v is not None})
            added.append(item["title"])
            continue
        before = json.dumps(current, sort_keys=True)
        for key in ("community", "title", "start", "end", "timezone", "venue", "address", "url", "source"):
            if item.get(key) is not None:
                current[key] = item[key]
        current["synced"] = True
        if not current.get("host") and item.get("host"):
            current["host"] = item["host"]
        if not current.get("description") and api_id:
            current["description"] = description_for(api_id)
        if json.dumps(current, sort_keys=True) != before:
            updated.append(current["title"])

    keep = []
    for e in events:
        if e.get("synced") and e["id"] not in found:
            removed.append(e["title"])
        else:
            keep.append(e)
    keep.sort(key=lambda e: e["start"])
    data["events"] = keep

    if not (added or updated or removed):
        print(f"Luma sync: {len(found)} matching events, no changes.")
        return
    DATA.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    for label, items in (("Added", added), ("Updated", updated), ("Removed", removed)):
        for title in items:
            print(f"{label}: {title}")
    subprocess.run([sys.executable, str(ROOT / "scripts" / "build.py")], check=True)


if __name__ == "__main__":
    main()
