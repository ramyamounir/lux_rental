# Luxembourg Rental Explorer

Viewable at [https://ramyamounir.github.io/lux_rental](https://ramyamounir.github.io/lux_rental)

An interactive map for comparing Luxembourg's 100 communes and Luxembourg City's 24
quartiers on affordability, transit connectivity, amenities, and safety/reputation —
built to help with deciding where to rent.

Live data sources, formulas, and known limitations are documented in
[`methodology.html`](methodology.html) — read that before trusting any number on the map.

## Project structure

```
lux-rental-explorer/
├── index.html              the map (open this)
├── methodology.html        data sources & how every score is calculated
├── style.css                shared styling for both pages
├── app.js                   map logic (Leaflet, scoring, UI)
├── data.js                  bundled data the app loads (generated from /data)
└── data/
    ├── communes.json         per-commune scores & attributes
    ├── communes.geojson      commune boundary polygons
    ├── quartiers.json        per-quartier scores & attributes
    └── quartiers_voronoi.geojson   quartier boundary polygons (Voronoi, not official)
```

`data.js` is a plain concatenation of the four files in `/data` into JS `const`
declarations, so the app can load them with a `<script>` tag instead of `fetch()` —
this keeps it fully static, with no server, build step, or CORS issues, so it also
just works if you open `index.html` directly from disk.

If you edit anything in `/data`, regenerate `data.js` to match (see below).

## Running locally

No build step. Either:

- Open `index.html` directly in a browser, or
- Serve the folder locally, e.g. `python3 -m http.server`, then visit `http://localhost:8000`

## Updating the data later

1. Edit the relevant file(s) in `/data`.
2. Regenerate `data.js` so the app picks up the change:

   ```bash
   python3 -c "
import json
out = ''
for name, path in [
    ('COMMUNES_GEOJSON', 'data/communes.geojson'),
    ('COMMUNES', 'data/communes.json'),
    ('QUARTIERS', 'data/quartiers.json'),
    ('QUARTIERS_GEOJSON', 'data/quartiers_voronoi.geojson'),
]:
    out += f'const {name} = ' + json.dumps(json.load(open(path)), ensure_ascii=False) + ';\n'
open('data.js', 'w').write(out)
print('data.js regenerated')
"
   ```
3. Update the vintage/source notes in `methodology.html` if the change affects them.
4. Commit and push — GitHub Pages redeploys automatically within a minute or two.

