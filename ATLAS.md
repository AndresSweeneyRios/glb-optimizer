# Private atlas renderer contract, version 1

`EXT_glb_optimizer_atlas` is a private, required extension attached to the three output materials. A standard glTF viewer cannot render these materials correctly without an adapter. It is registered with the optimizer's NodeIO; the WebGL2 GLTFLoader adapter is `runtime/three-atlas.js`.

## Material and geometry layout

Three logical materials are named `environment`, `table`, and `ceiling`. They share the same four KTX2 atlases. Constant materials occupy small 16×16 palette tiles; textured materials occupy density-budgeted tiles. A repeated wall/floor texture is represented once per material tile, without baking its repeated copies across geometry.

Every primitive contains `POSITION`, `NORMAL`, `TEXCOORD_0`, `_ATLAS_RECT` (four normalized interior rectangle coordinates), `_ATLAS_UV_SCALE` (the original UV span of a cropped patch), and `_ATLAS_WRAP` (two wrap modes: 0 repeat, 1 mirrored repeat, 2 clamp). Rectangle and wrap values are constant across a triangle. In Three.js the custom attribute names become lowercase. UVs retain their repeat range; their common source texture transform is applied to vertices before batching.

Non-repeating UV coverage is rasterized conservatively on WebGPU. A padding-aware guillotine partition cuts out useful patches, including unused interiors of connected islands. Triangles crossing patch boundaries are clipped with barycentric attribute interpolation; UVs are remapped to those regions, and compatible geometry is rejoined including inside instance meshes. Source texture slots currently must share a UV set, texture transform and wrap modes within a material. Independent per-slot mappings are rejected with a diagnostic. Vertex tangents are reconstructed from the original UV derivatives using `_ATLAS_UV_SCALE`, preserving normal mapping across nonuniform crops. Unrotated MaxRects packing fills two-dimensional gaps between padded tiles. Source animations, skins, morphs and unsupported material extensions are rejected by this static preset.

## Textures

- `atlas-color`: sRGB RGB with linear alpha; source base-color factors are baked in linear light.
- `atlas-normal`: linear tangent-space XYZ encoded in RGB. Source normal scale is baked and vectors renormalized.
- `atlas-msao`: linear **R metallic, G specular intensity, B ambient occlusion, A roughness**. Includes source scalar factors and AO strength. AO is the authored AO map, not newly ray-traced scene occlusion.
- `atlas-optics`: linear **R transmission, G (IOR−1)/2, B flags/(flagsScale or 3), A alpha cutoff**. Flags bit 0 means normal mapping, bit 1 means double-sided, bit 2 means unlit. New exports use flagsScale 7; older exports default to 3. Opaque tiles use alpha cutoff zero and alpha one. IOR range is 1–3.

Optional `atlas-emissive` and `atlas-specular` sRGB textures are emitted only when non-default emission/specular colors are used. Emission is normalized by a shared scale retained in the material's emissive-strength extension.

Textures remain referenced through conventional glTF material slots so standard KTX2 loaders can decode them. Their channel interpretation and UV wrapping are governed by this required extension. Metadata includes version, atlas dimensions, padding, safe maximum mip, and emissive scale.

## Padding and minification

Tiles and their positions align to 16 texels and receive 16 texels of mirrored bleed by default. Atlas mipmaps use a box filter. Derivatives are computed before wrapping; the shader limits the footprint to `floor(log2(padding))−2`, reserving one 4×4 GPU compression block of padding at the coarsest sampled mip. With 16px padding this means mip levels 0–2.

This intentionally bounds minification to avoid unrelated tiles bleeding through lower mip levels. Very distant tiled surfaces can alias more than independently mipmapped source textures. Arbitrarily deep seam-free minification needs texture arrays, region-specific mip addressing, or larger padding; those are not implemented here. Generating a conventional full atlas mip chain alone does not solve that problem.

## Transmission and instances

There are three logical asset materials. The environment has two geometry batches sharing its material: opaque geometry and transmissive geometry, distinguished by `optimizerTransmission` primitive extras. The adapter uses opaque/transmission raster variants of the same atlas shader so opaque surfaces populate the refraction background. That is an extra render state/pass, not another set of source PBR materials or atlases. The adapter currently creates four runtime material objects for the three logical materials.

Five current furniture instance batches reuse the environment atlas material. The ceiling remains a separate node and starts hidden in the comparison preview. The current asset therefore has ten geometry batches (nine with the ceiling hidden), not three draws. Renderer refraction passes may produce additional GPU submissions.

## Adapter usage

```js
import {optimizerAtlasPlugin} from './runtime/three-atlas.js';
const loader = new GLTFLoader()
  .setDRACOLoader(draco)
  .setKTX2Loader(ktx2.detectSupport(renderer))
  .register(optimizerAtlasPlugin);
const gltf = await loader.loadAsync('table.atlas.glb');
```

The shipped adapter supports Three.js WebGL2. The pool game also implements this contract in its native WebGPU renderer and uses the optimized asset in its production export pipeline.
