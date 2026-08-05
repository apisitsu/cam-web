# Changelog / Bug-fix log

Notable fixes and changes, newest first. Dates are absolute.

---

## 2026-08-05

### Fix — a drilled hole is round, and so is everything else small

"The chamfer is still not smooth, and so are the centre drill, the drill and the
tap." Every one of those is a small **round** tool, and that is the whole story:
a round feature is only as round as the grid under it. On the ½ mm cells the
setting asks for, a Ø6 bore is twelve cells across and a Ø3 centre drill is six —
a hexagon. Smoothing the slope (below) fixed the chamfer's *flank*; its rim, and
every hole beside it, was still a staircase in plan.

So the cell size is now a **ceiling** rather than the answer. `cellSizeFor` takes
the grid down to `CIRCLE_CELLS` (24) across the smallest cutter that actually
cuts — the same reasoning `voxelSizeFor` has always applied to the voxel block —
and two budgets pull it back:

- the **grid**, which every mesh build scans once per playback tick;
- the **carving**, which is what really binds. A stamp covers (2r/cs)² cells and
  the sweep steps every half cell, so halving the cell is eight times the work.
  A hole program has almost no cutting length and gets a very fine grid; a facing
  job with a Ø50 cutter keeps the coarse one it always had. The budgets bound the
  *refinement* only — a setting that is already expensive is left alone, because
  it is the operator's.

That was affordable only because the mesh stopped scaling with the grid.
`heightmapToSolidMesh` now **merges flat runs along a row**: a billet is mostly
untouched top and flat floor, and those cells are one rectangle however many
there are, while anywhere the surface does something — a slope, a wall, the rim
of a bore — every cell is still drawn in full. On a plate with four holes that is
121,593 quads down to 1,989, and the drilling job now simulates on a 0.125 mm
grid with a smaller mesh than the 0.5 mm one produced.

Merging leaves T-junctions where a long run meets a row subdivided differently.
They are exactly coplanar, so nothing shows; `merge:false` turns it off for
anything that wants edge-matched geometry, and the hole-free construction is
still checked that way.

### Add — a twist drill has a point

A drill was the one common tool with no shape in `cutters.js`, so it carved as a
flat-bottomed disc: a blind hole came out with a square floor, which is the one
thing every machinist knows a drill does not leave. `drill` is now a cutter of
its own — a 118° cone, adjustable to 135° for split points, on a body five
diameters long — and `T2(DRILL 9)` resolves to it. Reamers, taps and boring bars
still claim no shape: they cut no bore of their own, and the plain flat at their
own diameter is what they leave.

### Change — the library is a place in the sidebar

Saving to a **file** has gone from the sidebar rail: Save project, Open project
and the quick Save to library are all off it. The library keeps the same session
in the browser under a name with no dialog and no folder to find again, and a
rail carrying both ways to do one job is a rail on which nobody is sure which one
they used. What is left is one row of two glyphs — keep it, or hand the program
on — and the library opens **inside the sidebar** rather than in a popover:
saving something, looking through what is there, opening one and deleting two is
a session, and a layer that shuts when you click near its edge is the wrong
container for one.

Nothing is lost: a `.camweb.json` dropped on the window now opens as a project
(it would previously have been handed to the G-code parser), and the Sketch
page — which has no sidebar — keeps its own popover.

### Add — Simulate runs itself once the setup says what to simulate

A program, a stated billet and an origin are the three things that make "what
will this make?" answerable, and the moment all three are there the operator has
already asked. `engine/view/autoSim.js` describes the setup as a **key** rather
than a boolean, which is what makes this safe: a boolean stays true and re-carves
on every render, while a key changes only when the stock, the origin, the program
or the rotary face does. It holds off while a program is playing (a re-carve
would pull the block out from under the playhead) and while a run is going, so
typing a billet dimension digit by digit costs one run, not three.

### Add — a library, so work can be kept without being filed

Saving has meant writing a file since there was anything to save: a project to
`.camweb.json`, a program to `.nc`, and the browser's save dialog decides where.
That is the right way to *hand work on* and the wrong way to keep it. A file the
operator has to find again is a file they will open the wrong version of, and on
a tablet at the machine it may be a file they cannot find at all.

So the app now keeps its own store — names in, names out, no dialog, surviving a
reload. **Save to library** keeps the whole session under the name the work
already has; the **Library** panel saves under a name you choose and lists what
is there, with what each one holds (`412 blocks · 3 ops · a part`), how big it is
and when it was saved, plus Open and Delete on every row.

- `engine/savedWork.js` is the pure half: the record shape, the naming rules,
  the ordering. Keyed by **kind and name**, so re-saving replaces rather than
  piling up eight identical rows, and a program and a project may share a name.
  The name offered for a fresh save is made unique first, so pressing Save twice
  keeps two saves — overwriting is something you type, not something you get.
- `lib/workDb.js` is IndexedDB and nothing else. Two object stores: a small
  `meta` row per item, and the `data` payload beside it. Drawing the list from
  the payloads would deserialize every megabyte in the library — a project
  carries its STL as base64 — to show a column of names. Meta and data are
  written in one transaction, so the list can never show a row whose payload was
  never written. Not `localStorage`: 5 MB, strings only, and synchronous on the
  thread the viewport is drawing on.
- Opening a saved project goes through the same `applyProject` an opened
  `.camweb.json` does — split out of `openProjectFile` for exactly that. Two
  doors, one room: a session restored from the database and one restored from a
  file cannot come back differently.
- The Sketch page gets it too, on its own rail button. That page hides the
  sidebar, so without it a sketch could be saved to a file and never to the
  library that keeps it.

### Change — Export G-code downloads, rather than opening a save dialog

`Save G-code` used the File System Access API where it exists and fell through to
a download everywhere else. The picker is nicer on a desktop, and it does not
exist where this app is actually used from: served over the LAN to a tablet at
the machine, `showSaveFilePicker` needs a secure context and is simply absent, so
that path was already the fallback. One behaviour everywhere beats two that
differ by browser, and it matches the CAM panel's own Download NC button, which
has always worked this way. The project file keeps its Save-As — a project is
filed away, a program is handed on.

The exported name is now `programFileName`: keep the name the program arrived
with **only** when it already ends in a G-code extension (`.NC` stays `.NC` —
shop programs are uppercase), and otherwise put `.nc` on it. A session planned
from a model is named after the model, so exporting it used to hand back
`bracket.stl` with G-code inside.

### Fix — a chamfer is a face, not a flight of stairs

A chamfer simulated as a staircase. The height field was right: a chamfer mill
stamps a cone, and the heights it leaves across the cut ARE a ramp. The
triangulation threw that away — since the leaning-wall fix, every cell was drawn
as a flat tread over its own footprint with a vertical riser closing the step to
its neighbour, which is honest for a wall and a lie for a 45° face.

Both readings now come out of one test, made once per grid **node**: the up-to-
four cells meeting there either agree to within `SLOPE_CELLS` (2) cell widths —
one surface, and the node takes their mean height, which all four then share —
or they do not, and each cell keeps its own height there while a riser closes
the gap. The threshold is drawn where the cutters are: a 45° chamfer flank rises
exactly one cell per cell and a 60° one √3, while a wall rises by the depth of
cut, which at a ½ mm grid is many cells. A Z-level step is nowhere near it.

Averaging is exact on a plane, so the cone comes back as the flat face it is
rather than an approximation of one. A ramped floor and a ball nose's bowl come
right with it — both were staircases for the same reason. `meshSquare.test.js`
still holds the wall square; `meshSlope.test.js` holds the slope sloped, checks
the shell has no crack where the two meet, and can reproduce the old staircase
on demand by setting `slopeLimit` to nothing.

### Add — the position page says what is cutting and how fast

The readout posted a bare `T3`, which is the one thing on the panel an operator
cannot check against the machine by eye: every other number is a position. Two
programs in, `T3` is a Ø7 endmill in one and a Ø9 drill in the other.

It now names the tool, and posts the **feed** and **spindle speed** beside the
position. The name is the tool that actually cuts — `cam/effectiveTool.js`, the
same resolution the marker draws and the carvers carve with — falling back to
the program's own comment, and to nothing rather than to a guess.

Feed and speed are stamped on each segment by the interpreter (`f`, `rpm`, `fm`)
rather than divided back out of a distance and a time, which a dwell folded into
the same segment would quietly falsify. Both are posted the way they were
programmed: a lathe's `F0.15` is a feed per **rev**, so it is converted back
through the rpm it was multiplied by instead of appearing as the 180 mm/min
nobody typed, and under G96 the speed shown is the rpm the control is actually
chasing at that diameter, not the surface-speed S word.

---

## 2026-08-04

### Fix — the stale height-field mesh check now describes what is built

`heightmapToSolidMesh is a closed box` had been failing since before any of
this: it still described the *original* construction (one vertex per cell
centre, quads joining neighbours), which was replaced because it drew every
vertical face a cutter leaves as a quad leaning by one cell width. A check that
always fails is exactly as useful as no check at all — and it hid real failures
in the runs above it. It now holds the stepped solid to four fresh vertices per
planar quad, a floor at or below the stated base, and nothing above the blank's
top.

### Add — machined material is a different colour from raw stock

A single-colour block answers "what shape is left" and nothing else. It cannot
answer the question an operator actually has in front of a running simulation —
*did this pass cut anything, and where?* — because a face the tool has just been
through looks exactly like one it has never touched.

The turning sim has told them apart since it was written. That palette now lives
in `sim/stockColors.js` and all three models use it: bright steel for a cut
surface, amber for stock as it came. The height field colours each quad as it
emits it (a lowered cell top, and every step riser, are cut; the billet's four
sides and floor are not); the voxel block needs one bounds test — it starts
solid, so an exposed face is either the blank's own outside or one the tool made
by taking its neighbour away.

### Fix — a ramp begins in the air too

The blank's top comes from where a feed move **travels in XY** — the only thing
that proves material was there. But a ramp travels in XY *while descending from
the clearance plane*, and it was credited with its high end, so the clearance
plane went back on top of the blank as a slab of phantom material. A job then
simulated three or four passes deep before anything visibly came off. A
travelling move is now credited with its **lower** end, where it has actually
reached material.

### Fix — the voxel blank stops at the material, not at the clearance plane

A ten-pass job showed nothing coming off until pass six or seven. The blank was
the reason: the voxel block was sized to the **raw feed bounds**, and a plunge
is a feed move that *begins in the air above the billet*, so the block grew a
slab of phantom material on top of the real surface. The height field has always
inferred the surface with `feedTopZ` — from where a feed move actually travels
in XY, which is the only thing that proves material was there — and the voxel
path never got the same treatment.

With an ordinary cutter the slab is cleared on the way down and nobody notices.
With a cutter that only cuts near its tip, it cannot be cleared at all: it just
stands there as a roof over the whole cut.

Both models now derive the same blank (single rotary index only — with several
faces assembled in the part frame, "the top" is not one direction). On the same
ten-pass job they land within 0.1% of each other, which the node checks hold
them to.

### Fix — the cut follows the tool along a move, not a block at a time

Both simulators counted **whole feed moves**. A 50 mm `G1` is one feed move, so
the tool crossed the part with nothing happening and then the entire cut
appeared in a single frame — which from the outside is exactly "the material
does not come off in step with the tool", whichever model was running.

`feedProgressAt(path, seconds, aIndex?)` reports the cut as a **fractional**
feed count — whole moves done, plus how far into the one in progress — read off
the same clock the tool marker rides. `advanceCut` (shared by the height field
and the voxel block) carves that fraction of the move, and scrubbing back
refills and re-carves as before. A quarter of the way along a cut now has a
quarter of it gone.

This one was never visible from the engine or the routing rule: it lived in the
store's orchestration, which had no tests at all. `camStore.sim.test.js` now
drives the store against a stubbed worker and holds it to running the right
model, carving the program on the press, leaving the session scrub-able, and
asking for fractional targets as playback runs.

### Fix — voxels shorter than they are wide, so the groove is the tool's height

Refining the whole grid to hold a thin cut was the wrong lever. A cut is rounded
out to whole voxels, but the dimension it is ever wrong in is **Z** — the
groove's height is what the cutting body sets, and its outline needs no more
resolution than the operator asked for. Refining all three axes costs the *cube*
of the refinement, so a 0.5 mm cutter on an ordinary billet asked for 34M cells,
hit the grid budget, and was coarsened straight back to a groove that did not
match the tool.

`createVoxelStock` now takes a cell **height** as well as a footprint, and
`voxelSizeFor` refines only the height. The cost goes up in proportion instead:

```
tool  4.0 mm  →  groove 4.000 mm   grid 1 x 1.000 mm    68k cells
tool  3.0 mm  →  groove 3.000 mm   grid 1 x 0.750 mm    92k cells
tool  0.5 mm  →  groove 0.500 mm   grid 1 x 0.125 mm   540k cells
```

A playback step on that costs 30–90 ms in the worker, which is the same trade
the height field already makes.

### Fix — cut-with-playback comes back on for a voxel run

The old one-shot voxel run turned the switch off and nothing ever turned it back
on, so the playhead carved nothing on a model that can now carve step by step —
the material came off all at once or not at all. Starting a voxel session turns
it back on, the way switching machine mode already did.

### Fix — four ways a stated cutting body failed to reach the cut

The groove still came out wrong after the model was right, for four separate
reasons, none of them in the carvers:

- **Simulate handed back an uncut block.** Making the voxel run a session left
  the carving to `carveToPlayhead` — which does nothing when cut-with-playback
  is off, and the *old* one-shot voxel run turned that switch off for anyone who
  had used it. It now carves the whole program on the press, like the height
  field, and the playhead scrubs from there.
- **The grid ignored a thickness stated on a Tool table row.** `voxelSizeFor`
  was asked about the fallback picker's number only, so a per-tool slot cutter
  was carved on a grid coarser than its own groove. `thinnestCut` looks at every
  tool in play.
- **A thickness typed on the picker never reached a tool the program named.**
  Detection wins on the type and the size — rightly, a comment says both — but
  no comment syntax states a cutting-body length, so the operator's number was
  the only measurement there was, and it was dropped. `effectiveTool` now fills
  in the thickness and the shank from the fallback where the tool has none of
  its own, and still lets the tool's own row win.
- **The field showed a number that was not set.** `t` and `s⌀` displayed the
  implied value as their *value*, so it read as a setting already in force —
  press Simulate, nothing changes. They show it as a placeholder now: empty
  means not measured.

### Fix — the groove is the height of the tool, not of the voxel grid

A 0.5 mm cutting body carved on the 1 mm grid the box asks for came back as a
1 mm groove — twice the tool, and exactly what "the slot is taller than the
cutter" looks like. A cut is rounded out to whole voxels, so a grid coarser than
the thinnest thing being cut cannot report it.

`voxelSizeFor` refines the grid to four layers across the thinnest cut, whatever
resolution was requested — and `MAX_VOXELS` stops it short on a part too big to
afford that, saying so rather than quietly carving at a resolution that cannot
show the cut. The notice above the button reads out the size actually used.

### Add — the voxel sim carves with playback, like the height field

It was a one-shot: press Simulate and the finished part appears, with nothing of
how it got there. That is a fair trade for a slow model and a poor one to force
— and forced is what it became the moment an ordinary slot cutter needed this
model. `createVoxelSession` / `carveVoxelSessionTo` make it a session like the
other two: the playhead carves it, and scrubbing back refills the block and
re-carves (a cleared voxel carries no record of what was above it).

The grid budget is sized for that: every carve step re-scans the block to
rebuild its surface, so the ceiling bounds the scan, not the memory.

### Fix — a slot cutter's groove is simulated by the model that can hold it

Setting a cutting-body thickness and pressing Simulate still came back with a
full-depth channel, and the reason was never the cutter: it was **which
simulator ran**. A cutter that only cuts for its first few mm leaves a groove
with material standing over it — a keyseat. The height field keeps one top-Z per
XY column, so there is nowhere for that roof to live, and it comes off every
time. The voxel block holds it. Same program, same tool:

```
height field   ......................    the column is gone
voxel Z -6     ######################    roof intact
      Z -8     ......................    the 3 mm groove
      Z-10     ######################    floor intact
```

`engine/sim/method.js` now decides which model a setup needs — more than one
rotary index, or any tool with a stated cutting-body thickness — and both the
store's `simulate()` and the Simulate button read the same rule. The button
becomes **Simulate the undercut** with the voxel glyph, and a line above it says
what changed and that this model runs once rather than scrubbing with playback.
A run that silently swaps simulators owes the operator that sentence.

### Add — a slot cutter's shank diameter is a number you set

A slot mill is commonly **necked**: a wide cutting body on a narrower shank, so
the shank clears the walls of the slot it has just cut. The marker drew the
shank at the cutting diameter for every tool, which says the tool will rub when
it will not.

`s⌀` sits beside `t`, in the fallback picker and on each Tool table row, and
only for the slot cutter — every other type's shank is its own diameter, near
enough that asking would be noise. A **stated** shank also sizes the collet: the
holder grips the shank, so a Ø20 × Ø6-shank cutter now draws a small holder
where a plain Ø20 draws a big one. That is the whole point of a necked tool, and
a holder drawn off the cutting diameter denies it. Left unstated, nothing moves
for any type.

Marker only — the shank does not cut, and no collision or holder check is
performed (see the note under the CAM panel).

### Add — a slot cutter's cutting-body length is a number you set

A slot mill's second dimension is how far up it actually cuts — the depth it can
take in one pass. Nothing about the diameter implies it, and it was implied
anyway (`bodyRatio` × Ø), so the marker drew every slot mill as the same long
stick as an endmill.

`t` now sits next to the diameter, in the fallback picker and on each row of the
Tool table, and only for the slot cutter — every other type's cutting body does
follow its diameter closely enough not to ask. `defaultThickness` is what the
field starts from and what `endMillGeometry` falls back to, so nothing moved for
the other five types. Changing the type drops a thickness typed for the old one.

A **stated** thickness reaches the voxel carver as the tool's cutting length, so
a cutter that only cuts for its first few mm leaves material standing above
that — the one place a body length can show in the removal, and one a height
field could never express (a column has nothing below its own top). An implied
thickness deliberately does not: it is a drawing default, and silently capping
every cut at 3× the diameter is not something a guess has earned.

**Not a slot width.** A first attempt modelled the slot cutter as a disc on its
edge, so its thickness became the width of the cut — and drew it that way, on
edge and turned to the direction of travel. That is a slitting saw on a
horizontal arbor, not what this tool is here: it is a vertical cutter like every
other one in the catalogue, and the slot it leaves is its diameter wide. The
disc model and the feed-direction machinery it needed (`feedDirections`,
`feedFrame`, `feedHeading`) are gone.

### Fix — the tool marker takes the shape of the tool actually cutting

Picking a cutter type changed the simulation and left the tool on screen the
same stick, which reads exactly like a picker that does nothing. Three separate
causes, all of them now one path:

- **The type never reached the marker once a program named its tools.** `App`
  deliberately dropped the chosen type the moment a tool was detected, and the
  Tool table could only say Flat or Ball — a word that cannot express "face
  mill". So a detected Ø50 face mill was drawn as a Ø50 endmill.
- **A program posted from the CAM panel had no tool table at all.** `fanuc.js`
  writes `(TOOL: T1 FACEMILL Ø50)` on its own line and then a bare `T1 M06`;
  `parseToolTable` only ever read a comment sitting *on* the tool-change line,
  and `Ø50` was not recognised as a diameter either. Every posted program
  therefore simulated and drew with the fallback cutter, whatever tools the
  operator had chosen for the operations.
- **The carve and the picture resolved the tool separately.** `sim/session.js`
  merged detection and overrides its own way; `App.jsx` merged them another.

The precedence now lives once in **`engine/cam/effectiveTool.js`** — override,
then the program's comment, then the fallback, with the fallback used whole only
when nothing at all is known about the tool (which is exactly when the carvers
use it). Both `toolResolver` and the marker ask it, so what carves and what is
drawn cannot disagree.

### Add — a cutter type per tool in the Tool table

Every milling row now offers the same six glyphs as the fallback picker (plus
the included angle on a chamfer mill) instead of a Flat/Ball switch. The
highlighted glyph is what the row's tool *is*, detected or picked, and
`setToolCutter` keeps the flat/ball the carvers speak in step with it. A drill,
tap or reamer highlights nothing — none of the six shapes is a drill, and they
keep the plain stick they always had.

### Change — shoulder mills, face mills and slot drills are told apart

`gcode/tools.js` classified `SHOULDERMILL` as a face mill (they are drawn and
fed as different tools) and let `SLOT DRILL` fall through to `DRILL`. Both now
have their own type, and every detected type carries the cutter id it maps to.
A detected chamfer/spot mill consequently carves its real **cone** rather than a
flat floor.

---

## 2026-07-11

### Add — more turning tools in the holder dropdown

The turning-tool dropdown grew from two to six: the OD holders MVJNR and MVVNN
plus DCLNR 95° (DNMG 55°) and SCLCR 95° (CNMG 80°), a **boring bar** (round shank
into the bore, insert cutting the ID), and a **parting / grooving blade**. Each
carries a `kind` (`od` / `boring` / `parting`) and `LatheTool` dispatches to a
marker per kind. Selection and markers only — the sim still carves the outer
profile for every tool.

### Change — equal holder height; MVJNR 80° shank nudged clear of the edge

All four holders now top out at the same fixed radial height (the shank grows to
reach it), so they read as one family. For a laid-over insert (MVJNR at 80°) the
shank is nudged +Z just enough that the grey holder no longer pokes past the
insert's cutting edge; MVVNN and the tighter MVJNR angles get no nudge (0).

### Change — fixed shank width; MVVNN shank centred on the insert

Both holders now use the two-wall wedge head (both walls parallel to the insert
edges), and the head height is set to `W / (edge-slope span)` so the **shank is a
fixed width W for every insert angle** — the three MVJNR variants read identical.
Because the shank sits centred on the wedge, **MVVNN's symmetric insert centres
the shank on the insert** (straight, on-centre, at the insert angle); MVJNR's
asymmetric wedge offsets it so the tip juts out.

### Change — vertical shank, head bevelled to the insert angle

The shank stands **vertical** again (front/back faces at constant Z); only its
**head** — the front-bottom bevel — is cut to the insert angle. The bevel runs
along the insert's trailing (+Z) edge down to the cutting tip, so the tip juts
past the shank's front face on its own, at the correct lead. The insert keeps its
lead-angle position and orientation; the holder just seats it. (Supersedes the
brief tilted-shank version.)

### Fix — turning insert orientation per holder (MVVNN vertical, MVJNR tip out)

The insert now sits at (lead + angle/2) from the feed — its leading edge meets
the part at the lead angle — so MVVNN 72.5° with a 35° insert comes out with the
diagonal **vertical** (parallel to the shank, cutting corner centred under it),
while MVJNR 93° tips it back. A per-holder `tipOut` pushes the MVJNR cutting tip
**past the shank's front edge** (as the catalogue shows) while MVVNN stays flush.

### Fix — turning insert centred on the holder and fully visible

Two touch-ups on the extruded holder: the straight shank is now **centred on the
insert's Z** (the insert's centre sits on the holder centreline instead of off to
the front edge), and the gold insert is placed on the holder's **front face**
(toward the camera) so its whole face shows in gold instead of being half-buried
in the grey steel — the acute corner still lands on the cutting tip.

### Fix — turning holder is one extruded solid: straight shank, beveled head

The holder is now built from a **single silhouette** via `ExtrudeGeometry` — a
straight vertical shank whose front-bottom is beveled at the lead angle into the
head that seats the insert — instead of two stacked boxes with the whole thing
tilted. So the shank stays straight, the head is the angle that receives the
insert, and shank + head are one continuous piece of steel (MVJNR 93° = steep
bevel/upright, MVVNN 72.5° = a more open bevel).

### Change — two fixed turning holder types (MVJNR 93° / MVVNN 72.5°)

Cut the turning tool list down to the two catalogue holders (image_tool/): a
**MVJNR** at a fixed **93°** lead whose insert nose angle is adjustable (an
"insert°" field in the Tool table), and a **MVVNN** at a fixed **72.5°** lead
with a fixed VNMG 35° insert. Each holder uses the drawing's proportions (shank
height/depth, head length, insert overhang) and its fixed lead, drawn as one
rigid group so the head always seats the insert.

### Fix — turning tool: holder + insert as one rigid group (no gap/overhang)

The head and insert were rotated by separate formulas, so changing the lead angle
opened a gap on some subtypes and an overhang on others — the head no longer
seated the insert. The whole tool (head → shank → insert) is now built along one
local axis and the **entire group is tilted about the tip** by the (damped) lead
angle. Because the holder and insert rotate together as a rigid body, the head
seats the insert at every angle; the shank stays roughly upright and the insert
still shows its subtype shape.

### Change — cut vs raw colour, slower playback, tool picked in the Tool table

- **Machined vs raw stock now differ in colour.** The turning mesh carries
  per-vertex colours — bright steel where the tool has cut, amber where the raw
  bar survives (the chuck stub / un-turned OD) — so it's obvious what's been
  removed. `StockMesh` uses vertex colours when present.
- **Slower playback.** The speed control gained **0.25×** and **0.1×** for a
  close look at a cut.
- **One place to pick the tool.** The turning insert is now chosen **per tool in
  the Tool table** (each T row has an insert dropdown); the separate Tool
  dropdown in the material-removal panel is gone. The marker shows the insert of
  whichever tool is cutting.

### Fix — turning holder is one continuous piece (straight shank + angled head)

Reworked after the `image_tool/` catalogue drawings (MVJNR / MVVNN / the NX Tool
Subtype picker). The holder now reads as a **single grey piece**: a **fixed
straight vertical shank** (constant for every subtype — it doesn't tilt with the
lead), plus an **angled head** that bridges the shank down to the insert (this is
the "beveled front" that changes with the lead angle), overlapping the shank so
they merge rather than the earlier disconnected head box. The gold insert is
**prominent at the very tip**, its shape/angle following the subtype (CNMG 80°
wide → DNMG 55° → VNMG 35° slim → triangle → round), acute corner at the tip.

### Change — turning insert marker matches the selected subtype

The insert marker now reflects the tool picked in the dropdown. Each subtype
carries a `sides` / `angle` / `lead`: a **rhombic** insert (4-gon) is drawn with
its short/long diagonal at `tan(angle/2)`, so **CNMG 80°** looks near-square,
**DNMG 55°** narrower, and **VNMG 35°** a slim sliver; **TNMG/WNMG** draw as a
triangle/trigon (3-gon); **RCMT** as a round insert. The holder also tilts to the
insert's typical lead angle (45°–72°). Change the Tool dropdown and the marker's
insert shape and approach angle update to match.

### Change — cut-with-playback on by default; turning tool matches a real holder

- **Cut with playback defaults on**, so after a Simulate the stock carves as the
  playhead moves without having to flip the switch first.
- The turning `LatheTool` marker is restyled after a standard OD holder (per
  `image_tool/`): a gold **rhombic** insert (elongated diamond) with a centre
  clamp screw, seated on a grey steel holder that reaches up-and-back to the
  turret at 45°, the acute corner at the cutting tip.

### Feature — turning cut-with-playback: watch the bar turn down as the tool moves

Turning was a one-shot sim — the tool marker moved along the path during
playback but the stock never changed, so it looked like the tool passed through
the bar without removing anything. Turning now runs as a **stateful session**
(`createTurningSession` / `carveTurningSessionTo`): with **Cut with playback**
on, the bar is turned down progressively as the playhead advances (incremental
forward; reset-and-recarve when scrubbing back), so material comes off exactly
where and when the tool cuts it. Restart and play to watch a bar become the part.

### Fix — turning raw bar is one uniform size that the chuck actually grips

The raw bar and the chuck disagreed: the bar was turned-OD + oversize (Ø26.3)
but the chuck gripped the turned OD (Ø25.3), so the stock didn't read as one
bar. The chuck now grips the **raw bar** diameter, so the whole bar is a single
uniform size held in the chuck. The turned profile is also carved at a finer
axial resolution (≤0.25 mm) so it's smooth.

(Verified the material removal already follows the tool path: the simulated
radius profile matches the tool path's lower envelope to within a grid cell —
e.g. r3.67 at the neck, r11 near the chuck, faced to r0 at Z0.)

### Change — turning: no nose comp, oversize raw bar, standard tool marker

- **No nose-radius compensation.** The turning sim always cuts a **sharp corner**,
  so the profile follows the programmed tool path exactly. The Nose R inputs (the
  global one and the per-tool one in the tool table) are gone; the insert picker
  now only chooses the tool subtype for the marker's appearance.

- **Raw bar 1 mm oversize.** The billet now starts at the largest turned diameter
  **+ 1 mm** (editable "Stock ⌀ oversize"), so there is real material to remove
  down to the profile instead of the bar starting flush with the finished OD. On
  the test part the bar is Ø26.3 over a Ø25.3 part.

- **More standard tool marker.** `LatheTool` is redrawn as a standard OD external
  tool — a square steel shank to the turret, a head that seats the insert, and a
  gold rhombic insert with its corner at the cutting point — dropping the separate
  nose bulge.

### Fix — chuck visibility, Front lathe view, playback bar, playback zoom

Four viewport fixes from feedback:

- **Chuck.** The body was near-black and swallowed the jaws (the jaws sat inside
  the body cylinder). The body is now a medium grey and the three jaws **protrude
  forward** of the body face, in a lighter steel, so they read clearly gripping
  the bar. Chuck placement was also decoupled from the (now padded) framing
  bounds, keeping the 5 mm clearance exact.

- **Front is the lathe view.** The correct orientation was on the **Back** preset;
  Front/Back are now swapped in Turn mode so the **Front** preset (the default)
  shows chuck-left / face-right, as expected.

- **Playback moved to a viewport toolbar.** The transport (restart / play / speed
  / scrubber / time) left the sidebar and now sits in a bottom bar **in the same
  row as the view selector**, over the viewport.

- **Zoom no longer fights playback.** The camera refit (`CameraRig`) re-ran on
  incidental re-renders, and playback re-renders every tick — so any zoom the user
  set was snapped back to the fit, reading as "zoomed in too close, can't zoom
  out". The refit now runs **only** when the view, the fit request, or the bounds
  *values* change (keyed on a stable string), so it never fires during playback.
  The canvas also renders continuously (`frameloop` default) instead of on-demand,
  so OrbitControls zoom/orbit stays responsive while playing, and the turning
  frame is symmetric about the spindle with a little pull-back so the default view
  isn't a sliver.

### Fix — turning defaults to a sharp corner; removal follows the tool path

The turning sim removed material that didn't match the tool path. The cause was
the nose radius: the round-nose model (without nose-radius compensation) let a
tool's nose bulge into neighbouring slices below the programmed contour, cutting
too deep on slopes — e.g. a Ø-transition that should finish at r≈6.4 came out at
r≈4.9 with an R0.8 insert.

Turning now **defaults to a sharp corner** (nose R 0), and the sharp carve is
exact: every slice a move spans takes the segment's radius at that slice centre
(facing moves collapse to their deepest radius), so the profile follows the
programmed path precisely instead of being biased by point sampling. A **Sharp
corner (follows path)** entry leads the insert list; the real nose-radius inserts
remain for when rounding is wanted (they note that the profile may differ from
the path at slopes).

### Fix — 5 mm chuck clearance; the part no longer sits inside the jaws

The chuck jaws reached forward (+Z) over the machined part, so the workpiece
looked swallowed by the chuck. Now the chuck **front face sits 5 mm past the
deepest cut** and the jaws grip back along −Z, so there is a clear 5 mm gap
between the deepest machined feature and the chuck — the clearance an operator
actually leaves. The turning stock also extends 20 mm past the deepest cut at the
full bar radius (uncut), so the raw bar visibly runs through the gap and into the
chuck instead of floating.

### Fix — lathe view faces the right way; tool stands straight, insert face-on

Follow-up to the horizontal lathe view: the default preset was **Front**, which
with X-up mirrored the part (chuck on the right, +Z to the left). It is now
**Back** — +Z (the face) reads right, −Z (the chuck) left, radius up — so X and Z
line up the conventional way. The `LatheTool` holder no longer leans at 45°: it
rises straight up (+X) from the insert like a tool dropping in from the turret,
and the rhombic insert now lies in the ZX face plane (thin along Y) so its full
square/diamond face is seen straight-on in the lathe view instead of edge-on.

### Fix — conventional horizontal lathe view + realistic turning tool & chuck

Feedback with a reference CAM screenshot: the turning view stood the part on end
(the app is Z-up and the lathe spindle is the Z axis), so the tool and chuck read
wrong. The camera now makes **X (the radius) up in Turn mode**, laying the part
out horizontally with the tool coming in from the top and the chuck on the left —
the standard lathe view. Milling stays Z-up.

The `LatheTool` marker is now a gold rhombic carbide insert with its nose-radius
corner on a grey steel holder angled up-and-back to the turret (a clamp pad seats
the insert), matching the reference. The `Chuck` became a proper 3-jaw chuck — a
stepped body with a back plate and three stepped jaws gripping the bar OD at the
−Z end. The insert picker lists OD tool subtypes by their CAM names (OD 80° L,
55° L, trigon, round, …), each adopting its default nose radius.

### Feature — tool length, realistic turning tool, faced end + chuck

Three viewport/tool-table refinements:

- **Milling gauge length.** The tool table gained an **L** (length) field — tip
  to the collet face. The `EndMill` marker now sticks out exactly that far: the
  flutes and shank span the gauge length and the collet sits at the collet face,
  so a short vs long tool reads to scale. Detected from `L48-54` comments,
  editable per tool.

- **Realistic turning tool.** `LatheTool` was a rough prism; it is now a rhombic
  carbide insert (with a clamp screw and the nose-radius corner) on a steel
  toolholder that reaches radially out to the turret, and it takes the insert's
  nose radius so a Ø-big round insert looks different from a sharp one.

- **Faced end + chuck.** A facing pass to Z0 left the raw bar's clearance end (a
  couple mm past Z0) sticking out as a stub, because the radial field only
  cleared the Z0 slice. `detectFaceZ` finds the facing plane and the billet is
  now capped there — no stub. And a 3-jaw **chuck** is drawn gripping the stock's
  −Z end, so a lathe program reads as work held on the left.

### Feature — editable tool table: configure each tool to match the program

Detection reads the tools from comments, but a program with wrong or missing
comments (or a bare `T0606` lathe call) had no way to correct the cutter the sim
used. The read-only tool list is now an **editable tool table**: every tool the
program uses gets a row — milling shows an editable **diameter** and **Flat/Ball**
shape, turning shows an editable **nose radius** — and the edits (kept in
`toolOverrides`, keyed by tool number) win over detection everywhere the sim
resolves a cutter (height field, voxel, and turning). A "reset" per row reverts
to the detected value. So the simulated tooling can be made to match the real
program: overriding milling T3 from Ø7 to Ø12, or turning T0606's nose radius,
changes what the sim removes.

### Feature — turning material-removal sim, standard inserts + nose radius

Turning had no stock sim at all — the panel just said "backplot only", so the
Simulate button did nothing in Turn mode. New `engine/sim/turning.js` models the
lathe stock as a **radial profile** (one remaining radius per Z slice, the
cylindrical analogue of the milling height field): the insert sweeps the ZX
profile, its **nose radius** rounding the cut, and the finished `radius[z]` curve
is revolved back into a shaded solid. The Turn-mode panel now offers a **standard
insert** picker (CNMG/DNMG/WNMG/TNMG/VNMG/RCMT, each adopting its typical nose
radius), an editable **Nose R**, and a working "Simulate turning" button. On the
lathe test files it carves in a few ms.

### Fix — playback stuttered on programs with few, long moves (Turning)

Turning playback lurched: the lathe program is 88 segments but some run 13 s
each, and the tool marker only moved at segment boundaries — so over a 15 s
playback it advanced just 41 times, sitting frozen then jumping. The marker now
interpolates by continuous machine time *within* the executing segment
(`toolPointAt`), giving a distinct position every animation tick (375 over 15 s)
— it glides along long cuts. Milling was already smooth (many short segments) and
stays so.

### Change — open on a blank page instead of auto-loading the sample program

The app used to `parse(SAMPLE_GCODE)` on mount for an instant demo. It now opens
empty — no program, no backplot — and the user brings their own via
drag-and-drop, Open file, or the still-present Load sample button. All the panels
already guard the empty state (`stats`/`path`/`sim` are optional), so the blank
viewport shows just the grid and origin axes.

### Fix — playback ran by segment count, so only T3's tool appeared to move

Even with all tools drawn and detected, watching the program back showed only
T3's cutter running. The animation advanced a fixed number of *segments* per
tick, and T3's helical bores tessellate into ~91% of all segments while a face
mill or reamer is a handful of long moves — so the tool marker sat in T3 for
~91% of the run and every other tool flashed past in a frame or two.

The loop is now paced by **machine time** (`segmentAtTime` inverts `timeAt`): the
whole program plays in ~15 s at 1× regardless of how the moves tessellate. On
`O0004.NC` that turns T3's share from 91% of the animation into 54%, and gives
T1 the face mill 2.6 s of screen time, T5 1.1 s, T8 the reamer 0.9 s — each
tool's cutter now visibly runs and resizes to its detected diameter as it goes.

### Fix — "only T3 cuts" for good: multi-axis Simulate carves every face

The tool table, per-tool geometry and voxel engine were all in place, but the
*default* Simulate button still ran the height field, which carves a single
rotary index (the dominant one — A0, the B2 slot). So the out-of-the-box result
kept showing only T3's work; seeing the face mill, drill, chamfer and reamer
needed the user to know to switch index or reach for the Voxel button.

`store.simulate()` now inspects `stats.aIndices`: a **multi-axis** program routes
straight to the voxel sim, which carves every tool on every face into one block
(undercuts included), while single-axis jobs keep the scrub-able height field.
The primary button reads "Simulate all faces" on a 4-axis part, and the face
panel drops the misleading "pick a rotary index" picker for a plain list of what
runs where. On `O0004.NC` one click now removes 278 k mm³ across T1–T8 instead of
just T3's slot.

### Fix — orthographic camera: true 2D presets, and zoom no longer clips

Two viewport complaints, one root cause — the camera was a **perspective**
camera. A Top/Front/Side preset still had vanishing-point distortion, so it never
read as a flat 2D view; and zooming (an OrbitControls *dolly* that moves a
perspective camera bodily through the scene) pushed geometry past the fixed
near/far planes, so parts blinked out as you zoomed in or out.

The viewport is now **orthographic**. Presets are true parallel projections (2D
and flat), and dollying an ortho camera scales its frustum instead of moving it,
so the camera stays put in a generous depth slab and nothing clips at any zoom.
`CameraRig` sets `camera.zoom` to fill the canvas from the two in-plane extents
(so every view fills, as before) and parks the camera well outside a wide
[near, far] range. OrbitControls keeps orbit + pan + (frustum) zoom.

### Feature — voxel material-removal sim (undercuts + all rotary faces at once)

The height-field dexel stores one top-Z per XY column, so it is blind to two
things: material *under* an overhang (an undercut), and faces machined at
different rotary indices — a Z-up column can only be carved from straight above,
which is why the simulator carved one A index at a time.

New `engine/sim/voxel.js` is a 3D boolean lattice. A cut removes the swept volume
of the *oriented* tool: each segment carries its tool axis in the part frame
(from its A/B index via `toolAxisFor`, matching the interpreter), so a cutter
reaching in from +Y clears exactly the voxels it passes through — undercuts kept
— and every orientation carves into the same block. `voxelSurfaceMesh` extracts
the exposed faces as a shaded hull. `runVoxelSimulation` drives the whole program
(all indices, per-tool geometry) in one pass; on `O0004.NC` that is ~0.5 s at
1.5 mm / ~1.7 s at 1 mm. Wired as a one-shot **"Voxel · undercut"** button beside
the height-field Simulate (the voxel model isn't scrub-able, so it disables
cut-with-playback). `voxel_check.mjs` proves a horizontal bore leaves its roof
intact — the case the height field cannot represent.

### Fix — camera framed the 3D diagonal, so side/front views didn't fill

Every preset but Top looked zoomed-out on a 4-axis part. The fit used the box's
3D diagonal, which is dominated by whatever dimension is largest *even when it
points straight into the screen* — here the rapid retracts, rotated out to ±100
in depth, ballooned that diagonal, so front/side framed a 200 mm depth and the
part shrank to a sliver. Top happened to look right only because that depth was
in-plane there. The Fit button re-ran the same math, so it felt erratic too.

`CameraRig` now projects the box onto the actual screen axes for the view and
fits the two **in-plane** extents to the camera's vertical and horizontal FOV
(so wide-shallow and tall-narrow parts both fill), stepping back by the depth so
nothing clips. And the interpreter now returns **feed-only bounds** (the cutting
geometry) alongside the full bounds; the viewport frames those, so a program's
Z-clearance fly-overs no longer shrink the part. On `O0004.NC` the framed box
drops from 62×200×128 to the real 62×60×58.

### Fix — G28/G30 intermediate point ignored the lathe's U/V/W words

The reference-return handler read the intermediate point from X/Y/Z only, but a
lathe specifies it with the incremental words U/V/W (`G28 U0 W0`). `U0 W0` was
harmless (no move either way), but a non-zero `G28 U-10 W5` was silently dropped.
It now reads U/V/W (always incremental, whatever the distance mode) as well as
X/Y/Z. The accompanying warning is unchanged and remains correct: G28 returns to
a machine-home position that the G-code doesn't contain, so only the intermediate
leg is drawn — benign for programs like these, which `G0 Z100.` retract before
every G28 (verified: no rapid crosses the part at depth).

### Feature — auto-detect the tool table from comments; every operation now cuts

**Symptom:** on `O0004.NC` the simulation appeared to run "only T3". The cause
was two-fold. The height-field sim carves one rotary index at a time, and the
program's tools are split across faces — T1 face-mills at **A90**, T2/T4/T7/T8
drill/bore/chamfer/ream at **A270**, and only T3/T4/T5 (the B2 slot) sit at the
default **A0**, where T3 does essentially all the removal (T4/T5 just finish it).
On top of that, *every* move was carved with one global tool radius, so even the
operations that were at the right index came out the wrong size.

Shop programs name their tooling only in the tool-change comment
(`T3(ENDMILL D7 L48-54 - ROUGH B2)`), so a new `engine/gcode/tools.js`
(`parseToolTable`) reads **type** (endmill / ballnose / facemill / drill /
reamer / chamfer / tap / bore), **diameter** (`D7`, or a bare `DRILL 9`), and
**flute length** (`L48-54`) out of those comments. The interpreter tags every
segment with the active `T` number and returns the table — merged with what each
tool actually cut — as `stats.tools`.

The dexel simulator now resolves the cutter **per move** from that table
(`toolResolver`), so a slot roughed with a Ø7 endmill and a hole bored with a Ø9
drill each carve at their own size; the UI slider is only the fallback for tools
the program never described. With this, selecting A90 removes 16 482 mm³ (the Ø32
face mill) and A270 removes 28 274 mm³ (drill + pre-hole + chamfer + reamer) —
material that was previously invisible. `buildPath` carries the per-segment tool
number (`toolAt`), the panel lists the detected tools and highlights the one
cutting, and the tool marker resizes to the active cutter as the program plays.

### Fix — the tool/arbor didn't rotate onto the working face on a 4-/5-axis job

On a rotary-indexed program the backplot geometry is drawn in the **part frame**
(`toPartFrame` undoes the table rotation so each face sits where it belongs on
the workpiece), but the tool marker was always drawn rising straight up +Z. So
on `O0004.NC` — which indexes `A0/A90/A270` — the toolpath correctly wrapped
around the part while the cutter and arbor stuck straight up, punching through
the side of the part instead of standing normal to the face being cut.

The interpreter now tags every segment with the **B** index as well as A
(`toPartFrame` composes `Ry(-B)·Rx(-A)`; B is read only in milling, where it is
a rotary rather than a lathe cycle parameter), `buildPath` carries `rotaryB`
next to `rotary`, and `rotaryAt(path, k)` returns the `{a, b}` index in effect at
the playhead. `Viewport`'s `Tool` nests two groups — `Ry(-B)` outside, `Rx(-A)`
inside — so the whole cutter+shoulder+arbor tilts about the tool tip to match the
part frame. Verified: A0→tool along +Z, A90→+Y, A270→−Y, and a synthetic B90
index swings a machine +X cut to part-frame +Z with the tool normal to it.

### Fix — a single-depth program simulated to zero material removed

`feedTopZ` sized the stock top to the highest Z of a feed move that travels in
XY — the cut itself — to avoid a plunge's air travel inflating the billet (the
2026-07-10 fix below). But when a program plunges straight to size and then cuts
entirely at *one* depth (a plain slot/pocket with no facing pass), the highest
XY cut is also the deepest, so the stock top landed flush with the cut: the tool
tip rode the surface and removed **nothing**. `createSession`/`runSimulation`
(both of which route through `feedTopZ`) carved 0 mm³, tripping the
`playback_check.mjs` assertion `full.removedVolume > 0`.

`feedTopZ` now separates **multi-level** cutting (the shallowest cut is at the
surface → keep its Z, the tight value) from **single-level** cutting (the cut is
also the deepest → the surface is above it, so fall back to where the plunge
feed enters from the clearance plane). Multi-level programs — `O0004.NC` and the
sim end-to-end test — are unchanged; single-depth programs now remove material.
Surfaced by driving the three `nc_program/*.NC` files plus the repo's own
playback check.

---

## 2026-07-10

### Feature — Fanuc Macro-B, the 4th axis, and G28

Driven by `O0004.NC` (a 4-axis fork-end program). It parsed to **125 segments
and 0.0 mm of cutting** — the tokenizer wants a number after every address
letter, so `X#16`, `Y[0-#17]` and everything inside a `WHILE` loop silently
vanished. What was drawn were the handful of literal `Z100.` retracts.

**`engine/gcode/macro.js`** is a new pass that runs before the interpreter:
variables (`#502=28.85`, `#[#100]` indirection), bracket expressions with
correct precedence and unary minus, the functions `SIN COS TAN ASIN ACOS ATAN
SQRT ABS LN EXP FIX FUP ROUND` (Fanuc's away-from-zero rounding, not JS's),
`WHILE[cond]DOn … ENDn` with nesting, and `IF … GOTO/THEN`. It emits literal
blocks, loops unrolled, each carrying the **source line** it came from so the
editor highlight still tracks the toolpath. A program with no `#`/WHILE/GOTO is
returned untouched. Runaway loops abort with a message instead of the heap.

**4th axis.** The A word indexes the table, so programmed coordinates stay in
the stationary machine frame while the part turns. `interpret` tracks A and
emits geometry rotated into the **part frame** (`rotaryFrame: 'part'`), which is
what puts each face of a 4-axis job back where it belongs on the workpiece. Each
segment is tagged with its index and `stats.aIndices` lists them.

The dexel stock is a Z-up height field and assumes the tool points along +Z —
true in the machine frame, for one index at a time. So the simulator now carves
a single rotary index, chosen by the user (defaulting to whichever cuts most),
using `rotaryFrame: 'machine'`, and the panel says as much when it sees a 4-axis
program. `feedsBeforeAt` maps the playhead onto that index's feed moves.

**`G28`/`G30`** are consumed as the non-modal codes they are, drawn as far as
their intermediate point (machine home isn't in the program) and warned about.
Previously `G91 G28 Z0.` fell through to the modal motion mode. **`G80 Z100.`**
now retracts instead of dropping the move, and a modal arc block carrying only
centre offsets (`J-12`, a second full circle) is no longer skipped.

### Fix — stock top was the plunge height, not the material surface

`feedTopZ` took the highest Z of any feed move, but a plunge *is* a feed move
and it starts in the air: `G1 Z18.4 F800` from a Z30 clearance made the billet
30 mm tall. It now takes the highest feed move that travels in XY — the cut
itself — and falls back to the plunge height for a pure drilling program. On
`O0004.NC` the stock top drops from 30.000 to the real 18.425.

### Fix — `F0.2` on a lathe was timed as 0.2 mm/min

Turning mode inherited the mill's power-on feed mode (G94, mm/min), so a lathe
program that never writes `G99` had every cutting move timed in the wrong unit —
`F0.2` became 0.2 mm/min instead of 0.2 mm/rev × S, inflating the cycle time by
roughly the spindle speed (three orders of magnitude at 1000 rpm).

`interpret` now defaults `feedMode` to **G99 (per revolution) in turning** and
G94 (per minute) in milling, matching how the machines power up; `G98`/`G94`
still switch a lathe back. An F word on the wrong side of 1 mm/min or 40 mm/rev
cannot be meant in the active unit, so it now warns rather than silently
producing a cycle time off by 1000×.

### Fix — G71 profile blocks were executed twice, and as ordinary motion

On a real control, `G71 P(ns) Q(nf)` traverses the N(ns)..N(nf) profile
internally and resumes at the block **after** N(nf). The interpreter warned
"not expanded" and then fell through, so the profile blocks ran as plain
G0/G1/G2/G3 motion. A lathe program therefore drew its profile as a stray
single pass, and any `I`/`K` arc inside it hit `tessellateArc` under whatever
plane was modal — in G17 the `K` offset is discarded, collapsing the radius to
zero ("zero-radius arc").

`interpret` now expands **G71** (Fanuc type I stock removal, both the
`G71 U(d) R(e)` + `G71 P Q U W F` two-block form and the single-block `D` form)
into constant-radius roughing passes with a 45° pull-off, a semi-finish pass
along the contour offset by the `U`/`W` allowances, and a return to the cycle
start point. **G70** re-walks the same profile as the finishing pass. Both jump
past the blocks they consume. `G72`/`G74`/`G75`/`G76` still warn.

The per-block loop moved into an inner `runBlocks(from, to, sink)` so a cycle
can re-enter it — once with a collector sink to trace the profile (no geometry,
no stats, modal state restored), once with the real emitter. Jumps are
forward-only: an early version let `G70` target a profile above it and the main
loop re-entered the cycle until the heap died.

Lathe cycles in **Milling** mode now warn once with the fix ("switch the machine
mode to Turning"), and a zero-radius arc carrying a `K` offset in G17 says so.

### Feature — machine mode, view presets, cycle time & cutting length

**Milling / Turning mode.** `interpret(text, { mode })` now takes a machine
mode. In `'turn'` the default plane is G18 (ZX), the `X` word is read as a
**diameter** and halved into a radius (toggleable — `I`/`K`/`R` stay radial),
and `G99`/`G95` select feed-per-revolution, timed as `F × S` rpm. On a mill
`G98`/`G99` keep their canned-cycle retract-plane meaning. The viewport swaps
the end mill for a turning insert and draws the spindle centreline. The dexel
simulation carves a Z-up height field with an end mill, so it does not model a
rotating billet — turning is **backplot only** and the panel says so.

**View presets.** `iso / top / front / back / left / right`, plus a Fit button
(re-picking the active view refits the bounds). `Viewport.CameraRig` replaces
`FrameBounds` and keys off `view` + a `viewNonce` counter. Top/bottom are tilted
1e-3 off the world up-axis so OrbitControls' spherical coords stay non-degenerate.

**Cycle time & cutting length.** Every segment now carries a duration `t`
(seconds) derived from the modal feed rate; G0 moves are timed against a
configurable rapid rate (default 5000 mm/min), and `G4 P` dwells — plus the `P`
word of `G82`/`G89` — are billed to the preceding move. `stats` gained
`cycleTime`, `feedTime`, `rapidTime`, `dwellTime` and `totalLength`;
`stats.feedLength` is surfaced as *Cutting length*. `buildPath` packs a
`timePrefix` so `timeAt(path, playhead)` gives the elapsed machine time under
the scrubber. A feed move with no usable `F` (or `G95` with no `S`) falls back
to 100 mm/min and warns rather than yielding `Infinity`.

## 2026-07-08

### Fix — `DataCloneError: … out of memory` on load & during playback

**Symptom**

```
Uncaught DataCloneError: Failed to execute 'measure' on 'Performance':
Data cannot be cloned, out of memory.
    at logComponentRender (react-dom …)          ← during commitPassiveMountOnFiber
    at po (react-three-fiber reconciler chunk …)  ← R3F's bundled react-reconciler
```

The app crashed on the very first render and again on every playback tick,
leaving a blank/frozen viewport.

**Root cause**

React 19.2's dev-only **Performance Tracks** serialise each component's *changed*
props into a `performance.measure(...)` `detail`, which the browser
structured-clones. The serialiser walks objects element-by-element (to depth 3),
so a `Float32Array` toolpath (hundreds of thousands of floats) blows up memory.
The same tracking exists in **react-three-fiber's own bundled `react-reconciler`**
(the second stack frame). `camStore` already kept buffers out of Zustand state
for this reason, but `Viewport` re-introduced them as **React props** to
`Backplot` / `LineSet` / `StockMesh`, and they changed identity every 40 ms during
playback → continuous OOM.

**Change** — stop passing large typed arrays through React entirely.

| File | Change |
|---|---|
| `engine/bufferCache.js` | Added a `_view` slot + `setView`/`getView` for the buffers currently drawn (full or sliced). |
| `components/Viewport.jsx` | Computes the drawn buffers into the view-cache and passes only a scalar `drawVer` token (`"${bufVer}:${playhead}"`) and `simVer` down. |
| `components/Backplot.jsx` | `LineSet` reads its buffer from `getView()` via `bufKey`+`drawVer` (no array props) and **disposes** old geometry/material on change. |
| `components/StockMesh.jsx` | Reads `sim` from `getBuf()` via `simVer`; disposes old geometry. |
| `App.jsx` | Dropped the redundant per-tick `sliceUpTo` that allocated large arrays only to read a 3-number `toolPos`. |

See `docs/ARCHITECTURE.md` → "Critical invariant" for the rule that prevents
regressions.

### Fix — playback did not start (toolpath "ไม่วิ่ง")

Surfaced once the crash above was fixed. `camStore.play()` read `path` from
Zustand state (`const { path } = get()`), but `path` had been moved to
`bufferCache`, so it was always `undefined` → `if (!path) return` bailed and
`playing` never became `true`. Fixed to read `getBuf().path` (matching `step()`
and `setPlayhead()`, which were already correct).
