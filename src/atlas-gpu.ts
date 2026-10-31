import {create,globals} from 'webgpu';
import type {AtlasLayout,AtlasRegion} from './atlas.ts';

export interface MaterialPixels {
  region: AtlasRegion;
  images: (Uint8Array|null)[];
  base: number[];
  msao: number[];
  optics: number[];
  emissive: number[];
  specularColor: number[];
  normalScale: number;
  opaque: boolean;
}
const shader = `
struct Parameters {
  geometry:vec4u, atlasSize:vec4u, offsets0:vec4u, offsets1:vec4u,
  base:vec4f, msao:vec4f, optics:vec4f, emissive:vec4f, specular:vec4f, settings:vec4f
};
@group(0) @binding(0) var<storage,read> source:array<u32>;
@group(0) @binding(1) var<storage,read_write> color:array<u32>;
@group(0) @binding(2) var<storage,read_write> normal:array<u32>;
@group(0) @binding(3) var<storage,read_write> msao:array<u32>;
@group(0) @binding(4) var<storage,read_write> optics:array<u32>;
@group(0) @binding(5) var<storage,read_write> emissive:array<u32>;
@group(0) @binding(6) var<storage,read_write> specular:array<u32>;
@group(0) @binding(7) var<uniform> p:Parameters;
fn mirror(value:i32,size:i32)->u32 {let period=2*size;let q=((value%period)+period)%period;return u32(select(period-1-q,q,q<size));}
fn srgbToLinear(v:vec3f)->vec3f {return select(v/12.92,pow((v+0.055)/1.055,vec3f(2.4)),v>vec3f(0.04045));}
fn linearToSrgb(v:vec3f)->vec3f {return select(v*12.92,1.055*pow(max(v,vec3f(0.0)),vec3f(1.0/2.4))-0.055,v>vec3f(0.0031308));}
fn sampleImage(slot:u32,index:u32,fallback:vec4f)->vec4f {
  var offset=0xffffffffu;
  if(slot<4u){offset=p.offsets0[slot];}else{offset=p.offsets1[slot-4u];}
  if(offset==0xffffffffu){return fallback;}return unpack4x8unorm(source[offset+index]);
}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u) {
  let size=p.geometry.xy;let padding=p.atlasSize.z;
  if(id.x>=size.x+2u*padding||id.y>=size.y+2u*padding){return;}
  let x=mirror(i32(id.x)-i32(padding),i32(size.x));let y=mirror(i32(id.y)-i32(padding),i32(size.y));
  let inputIndex=y*size.x+x;
  let outputIndex=(p.geometry.w-padding+id.y)*p.atlasSize.x+p.geometry.z-padding+id.x;
  let base=sampleImage(0u,inputIndex,vec4f(1.0));
  let baseRGB=linearToSrgb(srgbToLinear(base.rgb)*p.base.rgb);
  let alpha=select(base.a*p.base.a,1.0,p.settings.y>0.5);
  color[outputIndex]=pack4x8unorm(vec4f(baseRGB,alpha));
  let normalTex=sampleImage(1u,inputIndex,vec4f(0.5,0.5,1.0,1.0));
  var n=normalTex.xyz*2.0-1.0;n=normalize(vec3f(n.xy*p.settings.x,n.z));
  normal[outputIndex]=pack4x8unorm(vec4f(n*0.5+0.5,1.0));
  let mr=sampleImage(2u,inputIndex,vec4f(1.0));
  let ao=sampleImage(3u,inputIndex,vec4f(1.0));
  let spec=sampleImage(4u,inputIndex,vec4f(1.0));
  msao[outputIndex]=pack4x8unorm(vec4f(mr.b*p.msao.x,spec.a*p.msao.y,1.0+(ao.r-1.0)*p.msao.z,mr.g*p.msao.w));
  let transmission=sampleImage(7u,inputIndex,vec4f(1.0));
  optics[outputIndex]=pack4x8unorm(vec4f(p.optics.x*transmission.r,p.optics.yzw));
  if(p.settings.z>0.5){let e=sampleImage(5u,inputIndex,vec4f(1.0));emissive[outputIndex]=pack4x8unorm(vec4f(linearToSrgb(srgbToLinear(e.rgb)*p.emissive.rgb),1.0));}
  if(p.settings.w>0.5){let s=sampleImage(6u,inputIndex,vec4f(1.0));specular[outputIndex]=pack4x8unorm(vec4f(linearToSrgb(srgbToLinear(s.rgb)*p.specular.rgb),1.0));}
}`;

/** One native device and compute pipeline per complete atlas build, not per tile. */
export async function createAtlasGPU(layout: AtlasLayout, optional: {emissive:boolean;specular:boolean}) {
  Object.assign(globalThis,globals);
  const gpu=create([]);
  const adapter=await gpu.requestAdapter({powerPreference:'high-performance'});
  if(!adapter || adapter.info.isFallbackAdapter) throw new Error('Atlas baking requires a hardware WebGPU adapter.');
  const device=await adapter.requestDevice();
  const module=device.createShaderModule({code:shader});
  const messages=await module.getCompilationInfo();
  const errors=messages.messages.filter(message=>message.type==='error');
  if(errors.length){device.destroy();throw new Error(errors.map(error=>error.message).join('\n'));}
  const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
  const bytes=layout.width*layout.height*4;
  const active=[true,true,true,true,optional.emissive,optional.specular];
  const output=active.map(enabled=>device.createBuffer({size:enabled?bytes:4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST}));
  // Opaque unused color pixels avoid allocating an unnecessary compressed alpha plane.
  device.queue.writeBuffer(output[0],0,new Uint32Array(layout.width*layout.height).fill(0xff000000));
  return {
    // Dawn's Node binding requires the GPU root to outlive all device work.
    lifetime:{gpu,adapter},
    adapter:{vendor:adapter.info.vendor,description:adapter.info.description},
    async bake(tile: MaterialPixels) {
      const data:Uint8Array[]=[];const offsets=new Uint32Array(8).fill(0xffffffff);let words=0;
      tile.images.forEach((image,index)=>{if(image){offsets[index]=words;data.push(image);words+=image.byteLength/4;}});
      const source=device.createBuffer({size:Math.max(4,words*4),usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
      let offset=0;for(const chunk of data){device.queue.writeBuffer(source,offset,chunk as Uint8Array<ArrayBuffer>);offset+=chunk.byteLength;}
      const parameters=new ArrayBuffer(160), uints=new Uint32Array(parameters),floats=new Float32Array(parameters);
      uints.set([tile.region.width,tile.region.height,tile.region.x,tile.region.y,layout.width,layout.height,tile.region.padding,0]);
      uints.set(offsets,8);
      floats.set(tile.base,16);floats.set(tile.msao,20);floats.set(tile.optics,24);
      floats.set([...tile.emissive,0],28);floats.set([...tile.specularColor,0],32);
      floats.set([tile.normalScale,Number(tile.opaque),Number(optional.emissive),Number(optional.specular)],36);
      const uniform=device.createBuffer({size:160,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
      device.queue.writeBuffer(uniform,0,parameters);
      try {
        device.pushErrorScope('validation');
        const entries=[source,...output,uniform].map((buffer,binding)=>({binding,resource:{buffer}}));
        const encoder=device.createCommandEncoder();const pass=encoder.beginComputePass();
        pass.setPipeline(pipeline);pass.setBindGroup(0,device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries}));
        pass.dispatchWorkgroups(Math.ceil((tile.region.width+2*tile.region.padding)/8),Math.ceil((tile.region.height+2*tile.region.padding)/8));pass.end();
        device.queue.submit([encoder.finish()]);await device.queue.onSubmittedWorkDone();
        const error=await device.popErrorScope();if(error)throw new Error(error.message);
      } finally {source.destroy();uniform.destroy();}
    },
    async read(): Promise<(Uint8Array|null)[]> {
      const arrays:(Uint8Array|null)[]=[];
      for(let i=0;i<output.length;i++) {
        if(!active[i]){arrays.push(null);continue;}
        const staging=device.createBuffer({size:bytes,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
        try {const encoder=device.createCommandEncoder();encoder.copyBufferToBuffer(output[i],0,staging,0,bytes);device.queue.submit([encoder.finish()]);await staging.mapAsync(GPUMapMode.READ);arrays.push(new Uint8Array(staging.getMappedRange()).slice());staging.unmap();}
        finally {staging.destroy();}
      }
      return arrays;
    },
    destroy(){for(const buffer of output)buffer.destroy();device.destroy();},
  };
}
