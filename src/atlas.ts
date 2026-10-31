import {MaxRectsPacker} from 'maxrects-packer';
/** Rectangles include padding. Coordinates and dimensions are integer texels. */
export interface AtlasTile { id: string; width: number; height: number }
export interface AtlasRegion extends AtlasTile { x: number; y: number; padding: number }
export interface AtlasLayout { width: number; height: number; regions: AtlasRegion[] }

/** Stable two-dimensional packing; tiles remain unrotated for tangent-space normals. */
export function packAtlas(tiles: AtlasTile[], { padding = 16, maxSize = 4096 } = {}): AtlasLayout {
  if (!Number.isSafeInteger(padding) || padding < 0 || !Number.isSafeInteger(maxSize) || maxSize < 1) throw new Error('Invalid atlas limits.');
  const ids = new Set<string>();
  for (const tile of tiles) {
    if (ids.has(tile.id)) throw new Error(`Duplicate tile ID: ${tile.id}`);
    ids.add(tile.id);
    if (![tile.width, tile.height].every(n => Number.isSafeInteger(n) && n > 0 && n + 2 * padding <= maxSize)) throw new Error(`Tile does not fit: ${tile.id}`);
  }
  const sorted = tiles.toSorted((a, b) => b.height - a.height || b.width - a.width || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (!sorted.length) return {width:1,height:1,regions:[]};
  const packer = new MaxRectsPacker(maxSize,maxSize,0,{smart:true,pot:false,square:false,allowRotation:false});
  for (const tile of sorted) packer.add(tile.width+2*padding,tile.height+2*padding,tile);
  if (packer.bins.length!==1) throw new Error('Atlas overflow; use multiple pages or increase maxSize.');
  const regions:AtlasRegion[]=packer.rects.map(rect=>({...rect.data as AtlasTile,x:rect.x!+padding,y:rect.y!+padding,padding}));
  return {width:Math.max(...regions.map(r=>r.x+r.width+padding)),height:Math.max(...regions.map(r=>r.y+r.height+padding)),regions};
}

/** Mirror with repeated edge texels, including when padding exceeds tile size. */
export function mirroredCoordinate(coordinate: number, size: number): number {
  if (!Number.isInteger(coordinate) || !Number.isSafeInteger(size) || size < 1) throw new Error('Invalid mirror coordinate.');
  const period = 2 * size;
  const wrapped = ((coordinate % period) + period) % period;
  return wrapped < size ? wrapped : period - 1 - wrapped;
}

/** GPU output is RGBA8, one packed u32 per pixel; no color conversion is applied. */
export const mirroredBleedWGSL = `
struct Parameters { width: u32, height: u32, padding: u32, outputWidth: u32 };
@group(0) @binding(0) var<storage, read> source: array<u32>;
@group(0) @binding(1) var<storage, read_write> destination: array<u32>;
@group(0) @binding(2) var<uniform> parameters: Parameters;
fn mirror(p: i32, size: i32) -> u32 {
  let period = 2 * size;
  let q = ((p % period) + period) % period;
  return u32(select(period - 1 - q, q, q < size));
}
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  let height = parameters.height + 2u * parameters.padding;
  if (id.x >= parameters.outputWidth || id.y >= height) { return; }
  let x = mirror(i32(id.x) - i32(parameters.padding), i32(parameters.width));
  let y = mirror(i32(id.y) - i32(parameters.padding), i32(parameters.height));
  destination[id.y * parameters.outputWidth + id.x] = source[y * parameters.width + x];
}`;
