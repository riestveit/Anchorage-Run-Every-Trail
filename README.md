# Anchorage Trail Planner

Pick any trails in the Municipality of Anchorage and get the shortest route that covers all of them, with distance,
climb, an elevation profile, a playable route animation and a GPX download. Covers the Anchorage Bowl, Eagle River,
Chugiak, Eklutna, Girdwood and the Chugach front range: about 7,500 trails and paths (1,430 mi), plus the street network
so routes can get between trail systems.

Everything runs in the browser. There is no server and no build step.

## Files

| File | What it is |
|---|---|
| `index.html` | The whole app |
| `trails.geojson` | The trail database the app loads (built from OpenStreetMap, with elevations) |
| `builder.js` | The database builder on its own, for reference (the same code is inside `index.html`) |

## Where the data comes from

The database is built from public data, entirely in the browser:

1. **Trails and streets**: OpenStreetMap, downloaded through the Overpass API and clipped to the Municipality of
   Anchorage boundary.
2. **Trail types** come from OpenStreetMap tags:

   | Type | OpenStreetMap tags |
   |---|---|
   | Groomed ski trail | `piste:type=nordic` |
   | Wide / gravel trail | `highway=track`, or a gravel/compacted surface |
   | Paved trail | named paved path (`surface=asphalt` etc., or `highway=cycleway`) |
   | Neighborhood path | unnamed paved path, footway with no surface, stairs |
   | Singletrack / dirt | every other path |
   | Horse trail | `highway=bridleway` |
   | Street (link only) | roads (plus sidewalks and crosswalks after a rebuild): routes can use them to get between trails, but they can't be picked |

3. **Elevations** from the public AWS Terrain Tiles (USGS 3DEP and others), sampled at every vertex on a ~9 m grid.
4. Connected pieces of the same trail are joined, so *Whole trail* selects all of it. Dead ends within 15 m of another
   line get a short link-only connector, because OpenStreetMap paths often stop just short of the street or path
   they meet.

## Updating the trails

In the app, open **5 Trail data** and press **Rebuild from OpenStreetMap**. That downloads the latest trails and
elevations (a minute or two) and saves the result in your browser. To publish it for everyone, press
**Download trails.geojson** and upload that file to this repository, replacing the old one.

A trail that's missing, misnamed or not connected properly is best fixed at the source: edit it on
[openstreetmap.org](https://www.openstreetmap.org), wait a few minutes, then rebuild.

## How routes are found

Same engine as Run-Every-Trail. Trails are split at every junction into pieces, and the planner solves the Rural
Postman Problem: cover every selected piece at least once, with the least total distance. It joins separate groups
of picks with a minimum spanning tree of shortest paths, pairs up odd-degree junctions with a minimum-weight perfect
matching (Edmonds' blossom algorithm), and walks the result as an Euler tour.

Changes for a city-sized network:

- Each solve uses only the part of the network around your picks, widening the window if it has to.
- Streets count as 1.5× their length when choosing links, so routes prefer trails. Distances shown are real.
- Odd-junction distances come from early-stopping Dijkstra searches. Selections with up to 160 odd junctions are
  matched exactly. Bigger ones use each junction's 80 nearest, which in tests stayed within about 1% of optimal.
- Picks that don't connect to the rest in the map data are left out, and the result says which.

## Credits

Trail and street data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), available under the
Open Database License. Elevations: AWS Terrain Tiles (Mapzen; USGS 3DEP and other public sources).
Basemaps: Esri World Topographic Map, USGS The National Map, Esri World Imagery.
