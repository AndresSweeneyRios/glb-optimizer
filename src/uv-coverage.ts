import {create,globals} from 'webgpu';

const code=`
struct Triangle {a:vec2f,b:vec2f,c:vec2f,lo:vec2f,hi:vec2f};
@group(0) @binding(0) var<storage,read> triangles:array<Triangle>;
@group(0) @binding(1) var<storage,read_write> coverage:array<u32>;
@group(0) @binding(2) var<uniform> settings:vec4u;
fn separates(axis:vec2f,t:Triangle,center:vec2f,halfSize:vec2f)->bool {
 let a=dot(axis,t.a-center);let b=dot(axis,t.b-center);let c=dot(axis,t.c-center);
 let radius=dot(abs(axis),halfSize);
 return min(a,min(b,c))>radius+1e-7||max(a,max(b,c))< -radius-1e-7;
}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=settings.x||id.y>=settings.y){return;}
 let index=id.y*settings.x+id.x;if(coverage[index]!=0u){return;}
 let size=vec2f(settings.xy);let lo=vec2f(id.xy)/size;let hi=(vec2f(id.xy)+1.0)/size;
 let center=(lo+hi)*.5;let halfSize=(hi-lo)*.5;
 for(var i=0u;i<settings.z;i++){
  let t=triangles[i];if(any(t.hi<lo-vec2f(1e-7))||any(t.lo>hi+vec2f(1e-7))){continue;}
  let ab=t.b-t.a;let bc=t.c-t.b;let ca=t.a-t.c;
  if(separates(vec2f(-ab.y,ab.x),t,center,halfSize)||separates(vec2f(-bc.y,bc.x),t,center,halfSize)||separates(vec2f(-ca.y,ca.x),t,center,halfSize)){continue;}
  coverage[index]=1u;return;
 }
}`;
export async function createUVCoverageGPU(){
 Object.assign(globalThis,globals);
 const gpu=create([]),adapter=await gpu.requestAdapter({powerPreference:'high-performance'});
 if(!adapter||adapter.info.isFallbackAdapter)throw new Error('UV coverage requires a hardware WebGPU adapter.');
 const device=await adapter.requestDevice();
 const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:device.createShaderModule({code}),entryPoint:'main'}});
 return {
  lifetime:{gpu,adapter},
  async rasterize(triangles:number[][][],width:number,height:number){
   if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width>128||height>128)throw new Error('Invalid UV coverage grid.');
   const bytes=width*height*4;
   const output=device.createBuffer({size:bytes,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
   const staging=device.createBuffer({size:bytes,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
   try {
    // Keep each dispatch bounded, including for large imported meshes.
    for(let start=0;start<triangles.length;start+=4096){
     const chunk=triangles.slice(start,start+4096),data=new Float32Array(chunk.length*10);
     chunk.forEach((t,i)=>data.set([...t[0],...t[1],...t[2],Math.min(...t.map(p=>p[0])),Math.min(...t.map(p=>p[1])),Math.max(...t.map(p=>p[0])),Math.max(...t.map(p=>p[1]))],i*10));
     const input=device.createBuffer({size:Math.max(4,data.byteLength),usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
     const uniform=device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
     try{
      device.queue.writeBuffer(input,0,data);device.queue.writeBuffer(uniform,0,new Uint32Array([width,height,chunk.length,0]));
      const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);
      pass.setBindGroup(0,device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[input,output,uniform].map((buffer,binding)=>({binding,resource:{buffer}}))}));
      pass.dispatchWorkgroups(Math.ceil(width/8),Math.ceil(height/8));pass.end();device.queue.submit([encoder.finish()]);await device.queue.onSubmittedWorkDone();
     }finally{input.destroy();uniform.destroy();}
    }
    const encoder=device.createCommandEncoder();encoder.copyBufferToBuffer(output,0,staging,0,bytes);device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);const result=Uint8Array.from(new Uint32Array(staging.getMappedRange()));staging.unmap();return result;
   }finally{output.destroy();staging.destroy();}
  },
  destroy(){device.destroy();},
 };
}

/** Disjoint rectangles cover every conservatively occupied cell. */
export function coverageRectangles(mask:Uint8Array,width:number,height:number){
 if(mask.length!==width*height)throw new Error('Invalid coverage dimensions.');
 const remaining=mask.slice(),rectangles:number[][]=[];
 while(remaining.some(Boolean)){
  let best=[0,0,0,0],bestArea=0;const heights=new Uint32Array(width);
  for(let y=0;y<height;y++){
   for(let x=0;x<width;x++)heights[x]=remaining[y*width+x]?heights[x]+1:0;
   const stack:number[]=[];
   for(let x=0;x<=width;x++){
    const current=x===width?0:heights[x];
    while(stack.length&&heights[stack.at(-1)!]>current){const i=stack.pop()!,h=heights[i],left=stack.length?stack.at(-1)!+1:0,area=(x-left)*h;if(area>bestArea){bestArea=area;best=[left,y-h+1,x-left,h];}}
    stack.push(x);
   }
  }
  if(!bestArea)throw new Error('UV occupancy cover made no progress.');
  rectangles.push([best[0]/width,best[1]/height,best[2]/width,best[3]/height]);
  for(let y=best[1];y<best[1]+best[3];y++)for(let x=best[0];x<best[0]+best[2];x++)remaining[y*width+x]=0;
 }
 return rectangles;
}

/** Padding-aware guillotine partition. Keep harmless empty pixels when extra bleed costs more. */
export function partitionCoverage(mask:Uint8Array,width:number,height:number,cost:(rect:number[])=>number):number[][] {
 const sum=new Int32Array((width+1)*(height+1));
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=(y+1)*(width+1)+x+1;sum[i]=Number(mask[y*width+x]!==0)+sum[i-1]+sum[i-width-1]-sum[i-width-2];}
 const count=(x:number,y:number,r:number,b:number)=>sum[b*(width+1)+r]-sum[y*(width+1)+r]-sum[b*(width+1)+x]+sum[y*(width+1)+x];
 function trim(x:number,y:number,r:number,b:number):number[]|null{
  if(!count(x,y,r,b))return null;
  while(!count(x,y,x+1,b))x++;while(!count(r-1,y,r,b))r--;while(!count(x,y,r,y+1))y++;while(!count(x,b-1,r,b))b--;
  return[x,y,r,b];
 }
 const normalized=(r:number[])=>[r[0]/width,r[1]/height,(r[2]-r[0])/width,(r[3]-r[1])/height];
 function partition(bounds:number[]|null,depth=0):number[][]{
  if(!bounds)return[];const[x,y,r,b]=bounds;let best=cost(normalized(bounds)),children:(number[]|null)[]|null=null;
  if(depth<12){
   const consider=(a:number[]|null,c:number[]|null)=>{const value=(a?cost(normalized(a)):0)+(c?cost(normalized(c)):0);if(value<best-.01){best=value;children=[a,c];}};
   for(let split=x+1;split<r;split++)consider(trim(x,y,split,b),trim(split,y,r,b));
   for(let split=y+1;split<b;split++)consider(trim(x,y,r,split),trim(x,split,r,b));
  }
  return children?(children as (number[]|null)[]).flatMap(child=>partition(child,depth+1)):[normalized(bounds)];
 }
 return partition(trim(0,0,width,height));
}
