# RULES_NOTES — evidence and reconstruction boundaries

Engine: base72, 24 definition types A–X, 72 physical copies, 7 usable followers per player (one further follower may be reserved as a score marker in physical editions). Ruleset version 1; save schema version 1.

## Primary references checked on 2026-10-14

1. **Big Box (2010), English rulebook**, publisher/retailer PDF:
   https://cundco.de/media/84/a4/ac/1773930056/CC_BigBox_2010_Rule.pdf?ts=1773930056
   - PDF page 17 (zero-based page 16), printed **B1**: photographed A–X inventory and exact physical counts:
     A2 B4 C1 D4 E5 F2 G1 H3 I2 J3 K3 L3 M2 N3 O2 P3 Q1 R3 S2 T1 U8 V9 W4 X1.
     D carries the start symbol S; four D copies including start. Ten shield symbols when weighted by copies.
   - PDF page 2, printed p.2: 72 landscapes including the start; each player has 7 figures available after setting aside score marker; turn order and matching edges.
   - PDF page 3, printed p.3: impossible drawn tiles are discarded and replaced within the same turn; a follower can only go on the newly placed tile and only on unoccupied connected region; finished road worth 1 per unique tile.
   - PDF page 4, printed p.4: a completed city earns 2 per unique tile plus 2 per shield (therefore a two-tile shieldless city = 4); monastery 9 when surrounded; majority/ties; completed-feature followers return after scoring; farmers stay.
   - PDF page 5, printed p.5: incomplete cities 1 per unique tile plus 1 per shield, roads 1 per tile, unfinished monastery 1 plus occupied neighbor tiles, farm scoring 3 per distinct completed city, field majority and ties.
   - The printed booklet contains several expansions. Only the base 72 tiles and base rules are included in this app.
2. **Current publisher-licensed farmer supplement**, Z-Man/Asmodee 2024 English:
   https://cdn.svc.asmodee.net/production-zman/uploads/2024/09/carcassonne_v3_supplement_en.pdf
   - PDF page 1 (zero-based page 0): farmers placed horizontally, no recovery during play, 3 points per finished adjacent city per independent field, tied majority receives full points. Page 2 concerns River/Abbot expansion; those are **excluded**.
3. **Hans im Glück official base-game page**:
   https://www.hans-im-glueck.de/en/game/carcassonne/
   - Current printed base game supports 2–5 players. Application uses frozen contract's 2–5 setup even though 2010 Big Box booklet historically covered 2–6; this is an intentional scope limit.

## IMPORTANT — what the sources did *not* prove

- The image of the 24 physical tile faces on B1 does not supply a machine-readable graph of all local city/road regions, half-field ports or per-farm touchingCities relationships.
- Prior Sol-owned workers visually matched all 24 topologies against the official B1 pixels. This is visual matching, not machine graph certification or a publisher-certified digitization. The field groups (a=N:L b=N:R c=E:L d=E:R e=S:L f=S:R g=W:L h=W:R), split cities and attached farms remain a reconstruction from those observations; do not claim machine-certified topology.
- The city pennant is attached to the local city component with index zero in supplied records. For F this is a single connected city; no ambiguity for shield scoring. No official illustration, texture, name or visual asset is embedded: UI/3D artwork is generated independently.
- The type field rotationalSymmetry is calculated from edge/feature topology (including shield counts and farm-to-city references), not decorative printed rooftop positions.
- This prerelease reconstructs topology and local farm anchors; visual matching of B1 pixels is not machine graph certification. Catalog digest changes when the corrected anchor coordinates change.
- This digital implementation uses exact frozen mechanics stated in CONTRACT.md (seeded FNV-1a → Mulberry32 → Fisher–Yates, all four legal rotations, replay-only saves). These determinism/serialization details are a software specification, NOT rules from the printed publisher materials.

## Edition-specific scoring choices

- All completed cities, including two-tile cities, earn 2 × (# unique physical tiles + shields), no legacy one-point-per-small-city exception.
- Final incomplete cities earn # unique physical tiles + shields. Completed cities score while the turn is finishing and must not score again at game end.
- Finished roads earn one per distinct tile, not one per road branch on the same tile. Different roads meeting at town intersections remain independent regions.
- Farms score once per distinct completed **connected-city graph component** per field; multiple fields adjacent to one city may each earn their own three points. Owner with the most farmers wins; tied owners each receive the full amount.
- No River, Abbot, garden, cathedral, inns, builders, traders, castles or unofficial rule variants.
