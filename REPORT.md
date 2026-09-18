# FlowSync — Cyber City OSM road-graph build report

Date: 2026-09-18T10:48:39.753Z
BBox: 28.49,77.07,28.52,77.11

## Endpoints (server-side, datacenter IP)
- https://overpass.openstreetmap.fr/api/interpreter — HTTP 200 (small queries) / sometimes 403 (WAF throttles big queries under burst; multi-filter form gets stubbed to ~375 nodes)
- https://overpass.kumi.systems/api/interpreter — HTTP 200 (used for final build) / intermittent 504 or XML-error under burst
- https://overpass.monicz.dev/api/interpreter — HTTP 200, but throttles to ~375-node stubs under load
- https://overpass-api.de/api/interpreter — HTTP 406 from datacenter (blocked); included as the browser fallback where a browser UA is allowed
Status: final build fetched via `https://overpass.kumi.systems/api/interpreter`. (Live pipeline run: kumi.systems returned HTTP 200 and produced a real, fully-connected build; artifacts regenerated from the cached Overpass skel for a deterministic committed snapshot.)

## Overpass query
```
[out:json];(way[highway~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|service|pedestrian|footway|road|track)$"](28.49,77.07,28.52,77.11);node(w););out skel;
```

## Highways included
motorway, trunk, primary, secondary, tertiary, unclassified, residential, living_street, motorway_link, trunk_link, primary_link, secondary_link, tertiary_link, service, pedestrian, footway, road, track

## Highway-class changes made (in order)
- Attempt 1: trunk/primary/secondary/tertiary only → graph fragmented; Shankar comp only ~73 nodes, other junctions disconnected.
- Attempt 2: + unclassified/residential/motorway → one giant network still split into ~47 components; the 4 junctions landed in 3 different components.
- Attempt 3: + all driveable classes incl. *_link + service + living_street + pedestrian + footway + road + track → OSM node-shared graph becomes ONE connected component (9197–9115 nodes) and all 4 junctions are mutually reachable. The bridge classes (pedestrian/footway/road/track) are required because Cyber City plazas, the metro underpass, and generic connectors carry the shared nodes that tie the corridors together.

## Graph
- nodeCount (written, single connected component) = 9115
- edgeCount = 9867
- total nodes fetched = 9296
- connected-component size (from Shankar Chowk) = 9115

## Junctions
| name | nodeId | degree | reachable |
|---|---|---|---|
| Shankar Chowk NH-48 | 1997715982 | 3 | true |
| DLF Cyber Park gateway | 6541634112 | 2 | true |
| Cyber City metro/underpass | 1648207861 | 2 | true |
| Cyber Hub roundabout | 1408792651 | 2 | true |

**All junctions in one connected component: true**
