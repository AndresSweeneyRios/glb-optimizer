import type {Document,Material,Primitive} from '@gltf-transform/core';
import type {ChartUV} from './uv-charts.ts';
interface Vertex {uv:number[];weights:number[]}
export function triangleUVs(primitive:Primitive,layout:ChartUV){
 const uv=primitive.getAttribute(`TEXCOORD_${layout.texCoord}`),indices=primitive.getIndices(),count=indices?.getCount()??primitive.getAttribute('POSITION')!.getCount();
 if(!uv)return [];
 const triangles:{ids:number[];uv:number[][];key:string}[]=[];
 const c=Math.cos(layout.rotation),s=Math.sin(layout.rotation);
 for(let i=0;i<count;i+=3){const ids=[0,1,2].map(j=>indices?indices.getScalar(i+j):i+j),points=ids.map(id=>{const p=uv.getElement(id,[]);return[layout.offset[0]+c*p[0]*layout.scale[0]-s*p[1]*layout.scale[1],layout.offset[1]+s*p[0]*layout.scale[0]+c*p[1]*layout.scale[1]];});triangles.push({ids,uv:points,key:points.map(p=>p.map(v=>Math.round(v*1e7)).join(',')).toSorted().join('|')});}
 return triangles;
}
function clip(polygon:Vertex[],axis:number,bound:number,greater:boolean){
 const output:Vertex[]=[];
 for(let i=0;i<polygon.length;i++){
  const a=polygon[i],b=polygon[(i+1)%polygon.length],insideA=greater?a.uv[axis]>=bound:a.uv[axis]<=bound,insideB=greater?b.uv[axis]>=bound:b.uv[axis]<=bound;
  if(insideA)output.push(a);
  if(insideA!==insideB){const t=(bound-a.uv[axis])/(b.uv[axis]-a.uv[axis]);output.push({uv:a.uv.map((v,j)=>v+t*(b.uv[j]-v)),weights:a.weights.map((v,j)=>v+t*(b.weights[j]-v))});}
 }
 return output;
}
function contains(rect:number[],uv:number[]){return uv.every((value,axis)=>value>=rect[axis]-1e-8&&(value<rect[axis]+rect[axis+2]-1e-8||rect[axis]+rect[axis+2]>=1-1e-8));}
/** Clip in UV space, interpolating every source attribute with the same barycentrics. */
export function clipPrimitiveToRegions(document:Document,primitive:Primitive,layout:ChartUV,regions:{rect:number[];material:Material}[]):Primitive[]{
 const semantics=primitive.listSemantics(),attributes=semantics.map(name=>primitive.getAttribute(name)!);
 const buckets=regions.map(()=>attributes.map(()=>[] as number[]));
 const triangles=triangleUVs(primitive,layout);
 const emit=(region:number,vertices:Vertex[],ids:number[])=>{
  const position=primitive.getAttribute('POSITION')!,source=ids.map(id=>position.getElement(id,[]));
  for(let i=1;i+1<vertices.length;i++){
   const triangle=[vertices[0],vertices[i],vertices[i+1]];
   const points=triangle.map(v=>[0,1,2].map(axis=>v.weights.reduce((sum,w,j)=>sum+w*source[j][axis],0)));
   const a=points[1].map((v,j)=>v-points[0][j]),b=points[2].map((v,j)=>v-points[0][j]);
   if(Math.hypot(a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0])<1e-16)continue;
   for(const vertex of triangle)attributes.forEach((attribute,ai)=>{const values=ids.map(id=>attribute.getElement(id,[]));for(let component=0;component<attribute.getElementSize();component++)buckets[region][ai].push(vertex.weights.reduce((sum,w,j)=>sum+w*values[j][component],0));});
  }
 };
 for(const triangle of triangles){
  const polygon=triangle.uv.map((uv,i)=>({uv,weights:[0,1,2].map(j=>Number(i===j))}));
  const span=[0,1].map(axis=>Math.max(...triangle.uv.map(p=>p[axis]))-Math.min(...triangle.uv.map(p=>p[axis])));
  if(Math.max(...span)<1e-5){const uv=[0,1].map(axis=>Math.max(0,Math.min(1,triangle.uv.reduce((sum,p)=>sum+p[axis],0)/3)));const owner=regions.findIndex(r=>contains(r.rect,uv));if(owner<0)throw new Error('UV point was not covered');emit(owner,polygon,triangle.ids);continue;}
  regions.forEach(({rect},index)=>{
   // A degenerate UV line on a shared boundary belongs to one side only.
   for(let axis=0;axis<2;axis++)if(span[axis]<1e-10&&!contains([axis===0?rect[0]:0,axis===1?rect[1]:0,axis===0?rect[2]:1,axis===1?rect[3]:1],axis===0?[triangle.uv[0][0],.5]:[.5,triangle.uv[0][1]]))return;
   let clipped=polygon;
   for(let axis=0;axis<2;axis++){clipped=clip(clipped,axis,rect[axis],true);clipped=clip(clipped,axis,rect[axis]+rect[axis+2],false);}
   if(clipped.length>=3)emit(index,clipped,triangle.ids);
  });
 }
 return regions.flatMap((region,index)=>{
  if(!buckets[index][0].length)return [];
  const result=document.createPrimitive().setMode(primitive.getMode()).setMaterial(region.material).setExtras({...primitive.getExtras()});
  attributes.forEach((attribute,ai)=>result.setAttribute(semantics[ai],document.createAccessor().setType(attribute.getType()).setArray(new Float32Array(buckets[index][ai])).setBuffer(attribute.getBuffer())));
  return [result];
 });
}
