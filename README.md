# RJTT Daily High Nowcaster

A live, single-page website that nowcasts the **daily maximum temperature at Tokyo Haneda (RJTT / AMeDAS station 44166)**. It blends official observations with bias-corrected model guidance and surfaces the local effects that throw global models off at this coastal site.

## What it does

- **Observations** — JMA AMeDAS station 44166 (羽田), 10-minute resolution, for the running high, current temperature, wind, humidity, sunshine and pressure. Cross-checked against RJTT METARs.
- **Model guidance** — JMA, ECMWF, GFS and ICON hourly 2-m temperature via Open-Meteo, each bias-corrected by its current error against the live observation (the correction decays over ~6 h).
- **Nowcast high** — the larger of the observed high so far and each model's corrected remaining-day maximum; the headline is the model mean with a min–max band.
- **Local signals (flags, not silent adjustments)** — sunshine/insolation, sea breeze (海風) onset and cap, urban-heat-island inland flow, dew-point air-mass read, and the RJTT TAF TX (forecaster max) group.
- **Approach & runway** — inferred north-flow / south-flow runway configuration and a Boso-Peninsula low-level-shear / turbulence flag, derived from the parsed METAR wind. These are operational situational-awareness only and do not change the temperature projection.

Data refreshes automatically every 5 minutes.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Page markup |
| `styles.css` | All styling |
| `app.js` | Data fetching, nowcast math, rendering, SW registration |
| `sw.js` | Service worker — caches the app shell, never the live data |
| `manifest.webmanifest` | PWA manifest (installable) |
| `favicon.svg` | Icon |

## Run locally

Because the service worker and `fetch` calls need an `http(s)` origin (not `file://`), serve the folder rather than double-clicking. Any static server works:

```bash
# Python (already on most machines)
cd rjtt-nowcaster
python3 -m http.server 8080
# then open http://localhost:8080

# or Node
npx serve .
```

> Double-clicking `index.html` still renders the UI, but the service worker won't register and some browsers restrict cross-origin `fetch` from `file://`. Use a local server for full functionality.

## Deploy

This is a fully static site — no build step, no backend.

**GitHub Pages**
```bash
git init && git add . && git commit -m "RJTT nowcaster"
git branch -M main
git remote add origin https://github.com/<you>/rjtt-nowcaster.git
git push -u origin main
# In the repo: Settings → Pages → Deploy from branch → main / root
```

**Netlify** — drag the `rjtt-nowcaster` folder onto https://app.netlify.com/drop, or `netlify deploy --dir=.`

**Vercel** — `vercel` from inside the folder (framework preset: *Other*).

**Cloudflare Pages** — connect the repo, build command empty, output directory `/`.

## A note on data sources & CORS

All three feeds are fetched client-side:

- **Open-Meteo** — sends permissive CORS headers; works from any origin.
- **JMA AMeDAS** (`jma.go.jp/bosai/...`) — public JSON; generally fetchable from the browser.
- **aviationweather.gov** (METAR/TAF) — if a browser ever blocks this with a CORS error, the dashboard degrades gracefully (the METAR/TAF source chip turns red and AMeDAS still drives the nowcast). If you need METAR/TAF guaranteed, put a tiny serverless proxy (Cloudflare Worker / Netlify Function) in front of it and point the fetch URL at that.

The source chip and the masthead "JMA 10-min table" link both open the official JMA table for station 44166 that backs the observation feed.

## Accuracy caveats

- Runway configurations are *typical* mappings and remain subject to ATC and noise-abatement procedures — treat them as at-a-glance, not flight-planning, guidance.
- If you settle against a specific market, confirm whether it uses Haneda (this station) or the JMA Tokyo station (Kitanomaru); they can differ by ~1 °C on sea-breeze days.
