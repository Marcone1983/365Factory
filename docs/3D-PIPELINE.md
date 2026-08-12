# 3D pipeline

The requirement this subsystem exists to meet: generated games must not look
like assemblies of boxes and cylinders. Real race tracks, distinctive cars,
distinctive weapons, characters that read as people.

That rules out the usual approach of composing primitives. What follows is
surface modelling — the same operations a modeller actually uses.

## Shading and occlusion

Three things decide whether a generated asset reads as an object or as plastic,
and none of them is triangle count.

**Baked ambient occlusion.** Every asset built from a recipe is ray-traced
against itself — 64 cosine-weighted rays per vertex through a surface-area
heuristic BVH (`src/lib/graphics/bvh.ts`, `occlusion.ts`) — and the result is
written to vertex colours, which glTF multiplies into the base colour. That is
what puts shadow in an eye socket, under a chin, between fingers and up inside a
wheel arch. It travels in three floats per vertex and needs no second UV set, no
lightmap atlas and no unwrap; an unwrap is precisely the step that would have to
be correct for a baked AO *texture* to be worth having.

**Area-weighted vertex normals, measured against the surface bulk.** A boolean
leaves a few large faces surrounded by many slivers whose normals are numerically
meaningless. Counting each face equally lets a sliver a thousandth of the size
swing the vertex normal as hard as the surface it sits on, and comparing the
smoothing angle pairwise lets one folded micro-face split the shading of every
face it touches. Both are fixed in `triangulate`: contributions are weighted by
area, slivers are excluded outright, and each face is tested against the
area-weighted bulk normal at the vertex rather than against its neighbours one at
a time.

**Normal maps normalised by measured gradient.** The Sobel response of a height
field depends on both the map's resolution and the frequency of whatever the
material happened to build, so a fixed coefficient bakes normals eight times too
strong at one scale and invisible at another. The synthesiser measures the
field's own mean gradient and normalises against it, which makes `relief` mean
one thing — how far the surface tilts — for every material at every resolution.
Height fields are also held below the map's Nyquist limit and supersampled where
the pattern is periodic, because a weave finer than four texels per cycle comes
back as moiré rather than as cloth.


## Mesh kernel

`src/lib/graphics/mesh-kernel.ts`

### Catmull-Clark subdivision

The core operation. A coarse control cage becomes a smooth limit surface:
face points, edge points, then vertex repositioning by the standard weights.
Every face becomes quads, and the surface converges rather than shrinking away —
tested by asserting that successive levels' bounding radii converge.

**Creasing** is what makes it usable for hard-surface models. Per-edge and
per-vertex crease weights let a car body read as smooth sheet metal while its
panel gaps, wheel arches and trim keep a sharp edge. Without creasing,
subdivision rounds everything into soap.

### Construction operators

| Operator | Use |
|---|---|
| `loft` | Sweep a surface through cross-sections — vehicle bodies, gun barrels, road surfaces |
| `revolve` | Solids of revolution — wheels, tyres, cylindrical parts |
| `extrude` | Prisms from an outline |
| `superellipseProfile` | Continuously blends between a diamond, an ellipse and a rectangle via one exponent — the shape family real car sections follow |
| `roundedRectProfile`, `ellipseProfile` | Standard sections |
| `decimate` | Vertex-clustering LOD |

Lofting is the important one. A vehicle silhouette is *authored as curves* and
swept, which is how vehicles are actually modelled — not assembled from a box
with a smaller box on top.

### Triangulation

`triangulate` computes Newell face normals and splits vertices where the angle
between adjacent faces exceeds a threshold. One parameter therefore controls
whether a surface reads as smooth or faceted: a raw cube at a 30° threshold
produces 24 vertices (every corner split, crisp edges), and at 179° produces 8
(fully smooth). Triangles are grouped by material so a multi-material body
becomes multiple glTF primitives.

## PBR texture synthesis

`src/lib/generation/pbr.ts`

One procedurally generated height field produces a coherent material set:

- **albedo** — base colour with the material's own noise character
- **normal** — tangent-space, derived from the height field with a Sobel operator
- **ORM** — occlusion, roughness and metallic packed into one texture's channels

The Sobel response scales with resolution, so the relief coefficient is
normalised against a 64-pixel reference. Without that normalisation a 512px map
bakes normals eight times too strong and every surface looks crinkled — a real
bug this pipeline had.

Material families — `car_paint`, `glass`, `rubber`, `metal_brushed`,
`metal_worn`, `asphalt`, `concrete`, `sand`, `skin`, `hair`, `fabric`,
`leather`, `emissive_panel` — each carry their own noise character, roughness
range and metallic behaviour. That per-family assignment is what stops every
generated asset from looking like the same plastic.

Texture resolution is per material slot. A character's eyes get a 128px map and
the body gets 512px, because a 512px map for eyes costs exactly as much and is
never seen at that density.

## glTF 2.0 GLB writer

`src/lib/graphics/gltf.ts` — written from scratch, no dependency.

Supports multi-primitive meshes, embedded PBR textures, node hierarchies, skins
with inverse bind matrices, and keyframe animations. Extensions:
`KHR_materials_clearcoat` (car paint, varnish), `KHR_materials_transmission`
(glass), `KHR_materials_emissive_strength` (lights).

Conformance is asserted directly against the binary specification rather than by
"a viewer opened it": magic and version, 4-byte chunk alignment, JSON padded
with spaces and BIN with zeroes, accessor min/max bounds on positions, and every
accessor within its buffer view.

`inspectGlb` and `validateGlb` parse a file back — used to validate models from
a generative-3D provider before they are accepted into a project.

## Model generators

`src/lib/generation/models/`

### Characters

Built from **anthropometric fractions** — segment lengths as proportions of
stature, breadth scaling as `mass^0.5` — with deltoid caps, a neck column and
arms offset by `shoulderHalf + armRadius × 0.72` so they read as attached rather
than merged into the torso. A skeleton with inverse bind matrices, plus baked
idle, walk, run and attack animations, ships in the same file.

Tested by silhouette: height must exceed width by 1.8×, and the height-to-depth
ratio must fall between 2.5 and 12. A slab with arms fails both.

### Vehicles

A longitudinal loft through cross-sections, with an opaque greenhouse shell and
inset glass — modelling the greenhouse as glass alone leaves a car that is
invisible from the side. Body width is computed separately from track width
(`bodyWidth = carWidth − wheelWidth × 1.35`, `track = carWidth − wheelWidth`),
so wheels sit proud of the bodywork instead of buried in it. Six classes:
hypercar, rally, muscle, formula, offroad, hover.

### Tracks

A closed circuit with banking, elevation, kerbs, barriers and runoff, generated
with its **gameplay data**: racing line, checkpoints with position and forward
vector, corner classification, lap length. The mesh and the data the game code
needs are produced together, so the code never has to infer a racing line from
geometry.

### Weapons

Multiple families with barrels, grips, sights and emissive detail, plus muzzle
and grip offsets so the game can attach effects at the right point.

## Triangle budgets, and the two counts

Two different numbers, both needed:

- **stored triangles** — what the file contains; governs download size and GPU
  memory. This is what a GLB inspector reports.
- **rendered triangles** — every node instance counted; governs frame time. A
  vehicle stores one wheel mesh and instances it at four nodes, so it draws
  substantially more than it stores.

Conflating these is a real bug this codebase had: the vehicle generator reported
29,104 triangles for a file containing 15,568. Both are now reported separately,
and the budget — a frame-time budget — is checked against the rendered count.

| Kind | Rendered budget |
|---|---:|
| character | 90,000 |
| vehicle | 140,000 |
| track | 400,000 |
| weapon | 60,000 |

## Runtime engine

`src/runtime/engine/` — the SDK copied into every generated 3D product.

| Module | Contents |
|---|---|
| `vehicle` | Raycast suspension, simplified Pacejka tyre model, friction circle, torque curve, automatic gearbox, Ackermann steering, anti-roll bars, downforce |
| `physics` | Rigid bodies, collision, spatial partitioning |
| `combat` | Armour and resistance damage model, i-frames, melee arcs, swept-sphere ballistics, hitscan with falloff and penetration |
| `gamepad` | Floating sticks, self-centring steering wheel, analogue pedals and triggers, d-pad, haptics, safe-area layout |
| `render` | PMREM image-based lighting, UnrealBloom, split-tone colour grading, SMAA, focused shadow camera |
| `world` | Scene graph, streaming, LOD switching |
| `fx` | Particles, trails, impact effects |
| `audio` | Positional audio, engine synthesis |
| `ui` | HUD, menus, touch controls |
| `state` | Save/load, settings persistence |

### The sky bug

Worth recording because it is exactly what runtime validation is for. The sky
dome was created at `viewDistance × 0.95`, which put it outside the camera's far
plane — the sky rendered black and nothing errored. The fix: radius
`max(10, viewDistance × 0.4)`, `depthTest: false`, `fog: false`,
`renderOrder = -1000`, and `onBeforeRender` recentring the dome on the camera so
it can never be escaped.

A build check would have passed. Only booting the product and asserting that
draw calls produce pixels found it.
