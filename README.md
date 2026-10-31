# GLB Optimizer

Standalone TypeScript CLI for automated GLB processing. Node executes TypeScript directly; no application framework or browser is required for optimization.

## Running

Requires Node 24+. Install the [Basis Universal encoder](https://github.com/BinomialLLC/basis_universal) (`basisu` on PATH) for KTX2 output. Native GPU commands additionally require a compatible driver.

```sh
npm ci
npm run cli -- inspect /path/to/input.glb
npm run cli -- optimize /path/to/input.glb /path/to/output.glb
npm run cli -- optimize /path/to/input.glb /path/to/output.glb --config presets/pool.json
npm run cli -- gpu
npm run check
npm test
```

The output directory must already exist. The input is never overwritten. Output goes through an atomic temporary-file rename; JSON reports go to stdout and encoder progress goes to stderr. Recognized standard glTF extensions round-trip; unrecognized extensions are refused on optimization rather than silently dropped. Remote resource fetching is not enabled.

## Modes

Without a config, conservative mode deduplicates accessors/materials/textures and reorders vertex/index data. It preserves hierarchy, skinning, morphs, animations and extras.

The explicit **static scene preset** bakes world transforms and changes the scene hierarchy:

- Partitions geometry into table, environment and a separate `Ceiling` node.
- Bakes source colors and metallic/specular/AO/roughness/normal/optical properties into shared atlases and palette tiles using native WebGPU compute. Joins geometry around three logical materials. The required private atlas shader preserves tiling; glass keeps a separate transmission geometry batch.
- Optionally keeps repeated opaque furniture as `EXT_mesh_gpu_instancing` batches beneath the environment node. Detects both shared source meshes and exact duplicate meshes. Rejects mirrored/sheared transforms for instancing, and keeps transparent/transmissive materials in ordinary batches.
- Removes authored-hidden geometry from this static output. The source GLB is untouched.
- Uses the table's world-space footprint, extruded over a configurable camera-height interval, as the reachable camera volume for texture budgeting.
- Accounts for triangle world dimensions, UV tiling, selected UV sets and `KHR_texture_transform`. Shared textures retain the highest resolution needed by their consumers; block rounding and shared usage mean the density budget is approximate.
- Defaults to 512 texels/metre on the table and 256 in the room, capped at 1024 px, without upscaling. FOV, viewport height and distance further limit distant detail.
- Produces mipmapped KTX2 textures: ETC1S for sRGB color, UASTC for linear PBR data and normal maps. Preserves linear/sRGB transfer metadata and renormalizes normals during mip generation. Geometry uses Draco compression.
- Refuses animation, skins, morph targets, pre-existing GPU instances and unsupported primitive extensions in static mode.

Settings are in [presets/pool.json](presets/pool.json), including encoder path, job/thread limits and instancing thresholds. World units are assumed to be metres.

The pool atlas preset currently goes from **24.18 MB to 3.01 MB**, with **three logical materials, four shared KTX2 atlases and nine geometry batches**, including five instance batches covering 35 repeated furniture parts. The ceiling starts hidden, leaving eight geometry batches visible. This is an asset-specific result, not a general compression guarantee. The game still loads its original asset; integrating the new hierarchy into the game's model setup is a separate change.

## Preview

```sh
npm run preview
```

Open http://localhost:8991. The preview compares `/projects/8ball/src/assets/3d/table.glb` with `output/table.atlas.glb`, reads `output/table.atlas.report.json`, and uses synchronized orbit controls and lighting. The ceiling starts hidden in both views and can be toggled independently from the merged room. This displays raw exported geometry without the game's generated cushions, geometry repairs or postprocessing.

To regenerate the current comparison:

```sh
mkdir -p output
node src/cli.ts optimize /projects/8ball/src/assets/3d/table.glb output/table.atlas.glb --config presets/pool.json > output/table.atlas.report.next.json
mv output/table.atlas.report.next.json output/table.atlas.report.json
```

## Remaining pipeline

The tiled-atlas bake and WebGL2 runtime adapter are implemented; their format, channel swizzles and limitations are documented in [ATLAS.md](ATLAS.md). Independent UV transforms per texture slot, WebGPU runtime rendering, vertex-color casting and impostors remain future stages; see [DESIGN.md](DESIGN.md).

Native Dawn WebGPU dispatch/readback is verified on the local RX 7700 XT using Mesa Vulkan. Atlas channel packing, factor baking and mirrored bleed run in native WebGPU compute. Image decoding/resizing/PNG serialization use Sharp; KTX2 compression uses the native Basis Universal encoder.
