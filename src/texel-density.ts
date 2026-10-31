import type { Accessor, Texture, TextureInfo } from '@gltf-transform/core';
import type { Transform } from '@gltf-transform/extensions';
import { textureBindings, type Bounds, type StaticPrimitive, type StaticSceneConfig } from './static-scene.ts';

/** Minimum distance between conservative triangle bounds and the reachable camera volume. */
export function boundsDistance(a: Bounds, b: Bounds) {
  return Math.hypot(...a.min.map((value,i) => Math.max(0,b.min[i]-a.max[i],value-b.max[i])));
}

/** Largest singular value of texture-pixel derivatives with respect to world metres. */
export function trianglePixelDensity(points: number[][], uv: number[][], width: number, height: number) {
  const e = points[1].map((v,i) => v-points[0][i]);
  const f = points[2].map((v,i) => v-points[0][i]);
  const l = Math.hypot(...e);
  if (l < 1e-10) return 0;
  const x = e.reduce((sum,v,i) => sum+v*f[i],0)/l;
  const y = Math.sqrt(Math.max(0,f.reduce((sum,v)=>sum+v*v,0)-x*x));
  if (y < 1e-10) return 0;
  const a = (uv[1][0]-uv[0][0])*width/l;
  const c = (uv[1][1]-uv[0][1])*height/l;
  const b = ((uv[2][0]-uv[0][0])*width-a*x)/y;
  const d = ((uv[2][1]-uv[0][1])*height-c*x)/y;
  const trace = a*a+b*b+c*c+d*d;
  const determinant = (a*d-b*c)**2;
  return Math.sqrt((trace + Math.sqrt(Math.max(0,trace*trace-4*determinant)))/2);
}
function read(accessor: Accessor, index: number) { return accessor.getElement(index,[]); }
function transformedUV(uv: number[], info: TextureInfo) {
  const transform = info.getExtension<Transform>('KHR_texture_transform');
  if (!transform) return uv;
  const [sx,sy] = transform.getScale(), [ox,oy] = transform.getOffset(), angle = transform.getRotation();
  return [ox+Math.cos(angle)*sx*uv[0]-Math.sin(angle)*sy*uv[1],oy+Math.sin(angle)*sx*uv[0]+Math.cos(angle)*sy*uv[1]];
}
export function planTextureSizes(primitives: StaticPrimitive[], dimensions: Map<Texture,{width:number;height:number}>, cameraBounds: Bounds, config: StaticSceneConfig) {
  const scales = new Map<Texture,number>();
  const focalPixels = config.camera.viewportHeight/(2*Math.tan(config.camera.verticalFov*Math.PI/360));
  for (const {primitive,pass} of primitives) {
    const material = primitive.getMaterial();
    if (!material) continue;
    const position = primitive.getAttribute('POSITION')!;
    const indices = primitive.getIndices();
    const count = indices?.getCount() ?? position.getCount();
    for (const {texture,info} of textureBindings(material)) {
      const size = dimensions.get(texture);
      if (!size) continue;
      const transform = info.getExtension<Transform>('KHR_texture_transform');
      const texcoord = primitive.getAttribute(`TEXCOORD_${transform?.getTexCoord() ?? info.getTexCoord()}`);
      if (!texcoord) throw new Error(`Missing UV set for ${material.getName()}.`);
      let scale = scales.get(texture) ?? 0;
      for (let i = 0; i < count; i+=3) {
        const ids = [0,1,2].map(offset => indices ? indices.getScalar(i+offset) : i+offset);
        const points = ids.map(id => read(position,id));
        const uv = ids.map(id => transformedUV(read(texcoord,id),info));
        const pixelsPerMeter = trianglePixelDensity(points,uv,size.width,size.height);
        if (pixelsPerMeter < 1e-8) continue;
        const triangleBounds = {min:[0,1,2].map(axis => Math.min(...points.map(p=>p[axis]))),max:[0,1,2].map(axis => Math.max(...points.map(p=>p[axis])))};
        const distance = Math.max(config.camera.minimumDistance,boundsDistance(triangleBounds,cameraBounds));
        const densityCap = pass === 'table' ? config.textures.tableTexelsPerMeter : config.textures.environmentTexelsPerMeter;
        const demand = Math.min(densityCap,config.camera.oversampling*focalPixels/distance);
        scale = Math.max(scale,Math.min(1,demand/pixelsPerMeter));
      }
      scales.set(texture,scale || 1);
    }
  }
  const plans = new Map<Texture,{width:number;height:number}>();
  for (const [texture,size] of dimensions) {
    const scale = Math.min(scales.get(texture) ?? 1,config.textures.maxSize/Math.max(size.width,size.height),1);
    // KHR_texture_basisu requires dimensions divisible by four. Keep aspect ratio to block precision.
    const longest = Math.max(size.width,size.height);
    const target = Math.min(longest,config.textures.maxSize,Math.max(config.textures.minSize,longest*scale));
    const width = Math.max(4,Math.ceil(size.width*target/longest/4)*4);
    const height = Math.max(4,Math.ceil(size.height*target/longest/4)*4);
    plans.set(texture,{width,height});
  }
  return plans;
}
