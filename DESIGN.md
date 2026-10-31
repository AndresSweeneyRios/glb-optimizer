# Pipeline contract

## Tiled material atlas

A repeated floor or wall tile occupies one atlas region, irrespective of how many times the geometry repeats it. Preserve the original UVs and their material texture transforms. A runtime shader applies REPEAT, MIRRORED_REPEAT or CLAMP_TO_EDGE in tile-local coordinates, then maps into the atlas interior.

This requires an explicit custom renderer contract. Merely rewriting UVs cannot preserve an arbitrary repeating tile inside a conventional glTF atlas. Combining multiple such materials into one primitive also needs an integer region/material selector per vertex, compatible PBR state and corresponding runtime support. The private required extension and WebGL2 runtime reader are now implemented; see ATLAS.md. Unsupported viewers must not assume these are ordinary glTF materials.

Each texture channel requires appropriate defaults and color-space treatment: base color and emissive are sRGB; normal/roughness/metallic/occlusion are linear data. Different UV sets, transforms, alpha modes, double-sided state and material extensions constrain which materials can merge. Unsupported combinations must be reported and retained separately.

Padding mirrors each source edge outward by 16 texels by default. UV derivatives must be computed before wrapping and used for explicit-gradient sampling. Mirrored bleed alone does not prevent neighboring regions contaminating low mip levels: constrain usable levels with block-aligned padding (implemented), or generate region-local mips / use arrays for deeper minification (future work). This is a correctness requirement before enabling mipmapped tiled atlases.

## Aggregation and animation

Aggregate only compatible attribute layouts and render states. Static transform baking must account for inverse-transpose normals, tangent handedness and negative determinants. Preserve animated nodes, joints and skeleton relationships. Skinned merges require compatible skins and remapped joint indices; morph targets need compatible names/weights, transformed deltas and preserved animation channels. Skip unsafe merges with diagnostics.

## Camera-aware texel density

The static preset accepts texels-per-metre budgets and an AABB camera envelope derived from the table footprint plus configurable camera heights, vertical field of view and viewport pixel height. Other envelope shapes and orthographic budgeting remain future work. Estimate projected demand from the closest reachable camera position to an object's surface, with near-plane and maximum-resolution clamps. A camera envelope overlapping geometry cannot imply finite density without these clamps. A future orthographic policy should use its fixed world-space view height. Shared textures use the greatest demand across their consumers.

## Casting and impostors

Vertex-color casting samples source materials onto vertices; it cannot reproduce detailed textures on sparse meshes without adding vertices. Keep material channels and alpha behavior explicit.

Single-view impostors replace geometry with a rendered plane for a restricted camera range. Multi-view/flipbook impostors render a grid of viewpoints and need runtime view selection; they are not inherently animated sprites. Both are opt-in approximations. Preserve source geometry by default.

## Scheduling

Use Node worker threads for independent CPU jobs and asset decoding. Use a bounded GPU queue for image kernels and casting. Account for upload/readback costs and peak memory; do not create a GPU device for every primitive. Local multicore processing is the initial target, not a distributed cluster service.

## Delivery stages

1. Implemented: inspect, conservative optimization, GPU probe, atlas layout and bleed kernel; static table/environment/ceiling partitioning, safe world-space material batching, opaque furniture instancing, camera-volume texture sizing and native mipmapped KTX2 compression.
2. Implemented: WebGPU material channel baking and mirrored bleed, shared KTX2 atlases, palette tiles, three logical output materials, a private required glTF extension and a WebGL2 shader adapter. Independent per-slot UV mappings and a WebGPU runtime adapter remain future work.
3. Vertex-color casting, broader camera-volume support and bounded multi-asset batch workers.
4. Optional single/multi-view impostors after confirming desired use cases and runtime contract.

Every stage should report which changes ran, which were skipped and why, before/after sizes and timings. Benchmarks must include complete upload/readback and serialization costs, not shader dispatch time alone.

## Linked geometry

glTF retains linked geometry through multiple nodes referencing the same mesh index; no Blender-specific flag is required. Exact deduplication also discovers separately exported meshes with identical vertex/index data and materials. Static instancing groups are isolated from table and ceiling geometry. They preserve per-instance world TRS and names in extras. Alpha blending, transmission, volume, negative scale and non-TRS shear are excluded from instancing. The configuration can disable instancing to compare memory savings against additional material batches. Instancing may add draws relative to fully merging every object using a material; its main benefit here is reduced duplicated vertex data.
