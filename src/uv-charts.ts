import type{Document,Material,Mesh,Primitive}from'@gltf-transform/core';
import type{prepareStaticScene}from'./static-scene.ts';
export interface ChartUV {texCoord:number;scale:number[];offset:number[];rotation:number;wrapS:number;wrapT:number}
type Prepared=ReturnType<typeof prepareStaticScene>;
const key=(uv:number[])=>uv.map(value=>Math.round(value*1e7)).join(',');
function triangleUVs(primitive:Primitive,layout:ChartUV){
 const uv=primitive.getAttribute(`TEXCOORD_${layout.texCoord}`),indices=primitive.getIndices(),count=indices?.getCount()??primitive.getAttribute('POSITION')!.getCount();
 if(!uv)return [];
 const triangles:{ids:number[];uv:number[][];key:string}[]=[];
 const c=Math.cos(layout.rotation),s=Math.sin(layout.rotation);
 for(let i=0;i<count;i+=3){const ids=[0,1,2].map(j=>indices?indices.getScalar(i+j):i+j),points=ids.map(id=>{const p=uv.getElement(id,[]);return[layout.offset[0]+c*p[0]*layout.scale[0]-s*p[1]*layout.scale[1],layout.offset[1]+s*p[0]*layout.scale[0]+c*p[1]*layout.scale[1]];});triangles.push({ids,uv:points,key:points.map(key).toSorted().join('|')});}
 return triangles;
}
/** Topology and scheduling stay on CPU; cropped pixels are baked and padded by WebGPU. */
export function splitUVCharts(document:Document,prepared:Prepared,layoutFor:(material:Material)=>ChartUV,sourceSize:(material:Material)=>{width:number;height:number}|null,padding:number){
 const groups=new Map<Material,Primitive[]>();
 for(const item of prepared.primitives){const material=item.primitive.getMaterial();if(!material)continue;const group=groups.get(material)??[];group.push(item.primitive);groups.set(material,group);}
 const mappings=new Map<Material,{lookup:Map<string,number>;materials:Material[];layout:ChartUV}>();
 const report:{material:string;charts:number;usedArea:number;skipped?:string}[]=[];
 for(const[material,primitives]of groups){
  const size=sourceSize(material);if(!size)continue;
  const layout=layoutFor(material),triangles=new Map<string,ReturnType<typeof triangleUVs>[number]>();
  for(const primitive of primitives)for(const triangle of triangleUVs(primitive,layout))triangles.set(triangle.key,triangle);
  const unique=[...triangles.values()];
  if(!unique.length||unique.some(triangle=>triangle.uv.some(uv=>uv.some(value=>value < -1e-5 || value > 1+1e-5)))){report.push({material:material.getName(),charts:1,usedArea:1,skipped:'Repeated UVs: full tile retained'});continue;}
  const parent=unique.map((_,i)=>i),find=(i:number):number=>{let root=i;while(parent[root]!==root)root=parent[root];while(parent[i]!==i){const next=parent[i];parent[i]=root;i=next;}return root;};
  const edges=new Map<string,number>();
  unique.forEach((triangle,index)=>{for(let edge=0;edge<3;edge++){const edgeKey=[key(triangle.uv[edge]),key(triangle.uv[(edge+1)%3])].sort().join('|');const previous=edges.get(edgeKey);if(previous!==undefined)parent[find(index)]=find(previous);else edges.set(edgeKey,index);}});
  const islands=new Map<number,number[]>();
  unique.forEach((_,index)=>{const id=find(index),items=islands.get(id)??[];items.push(index);islands.set(id,items);});
  const crop=(ids:number[])=>{
   let minU=Infinity,minV=Infinity,maxU=-Infinity,maxV=-Infinity;
   for(const index of ids)for(const uv of unique[index].uv){minU=Math.min(minU,uv[0]);minV=Math.min(minV,uv[1]);maxU=Math.max(maxU,uv[0]);maxV=Math.max(maxV,uv[1]);}
   const left=Math.max(0,Math.floor(minU*size.width)-2),top=Math.max(0,Math.floor(minV*size.height)-2);
   const right=Math.min(size.width,Math.ceil(maxU*size.width)+2),bottom=Math.min(size.height,Math.ceil(maxV*size.height)+2);
   return[left/size.width,top/size.height,Math.max(1,right-left)/size.width,Math.max(1,bottom-top)/size.height];
  };
  let charts=[...islands.values()],rectangles=charts.map(crop);
  const area=(r:number[])=>r[2]*r[3];
  const whole=crop(unique.map((_,index)=>index));
  // Chart splitting is useful only when it wins after accounting for per-chart padding.
  const cost=(r:number[])=>Math.max(16,r[2]*size.width)+2*padding;
  const chartCost=rectangles.reduce((sum,r)=>sum+cost(r)*(Math.max(16,r[3]*size.height)+2*padding),0);
  const wholeCost=cost(whole)*(Math.max(16,whole[3]*size.height)+2*padding);
  if(charts.length>128||chartCost>=wholeCost*.85){charts=[unique.map((_,index)=>index)];rectangles=[whole];}
  const usedArea=rectangles.reduce((sum,r)=>sum+area(r),0);
  if(usedArea>=.9){report.push({material:material.getName(),charts:1,usedArea:1,skipped:'No useful UV crop'});continue;}
  const lookup=new Map<string,number>(),materials=charts.map((indices,index)=>{
   for(const id of indices)lookup.set(unique[id].key,index);
   return material.clone().setName(`${material.getName()} UV ${index+1}`).setExtras({...material.getExtras(),optimizerUVRect:rectangles[index],optimizerSourceMaterial:material.getName()});
  });
  mappings.set(material,{lookup,materials,layout});report.push({material:material.getName(),charts:charts.length,usedArea});
 }
 function split(primitive:Primitive):Primitive[]{
  const mapping=mappings.get(primitive.getMaterial()!);if(!mapping)return[primitive];
  const buckets=new Map<number,number[]>();
  for(const triangle of triangleUVs(primitive,mapping.layout)){
   const chart=mapping.lookup.get(triangle.key);if(chart===undefined)throw new Error('UV chart topology changed during splitting');
   const indices=buckets.get(chart)??[];indices.push(...triangle.ids);buckets.set(chart,indices);
  }
  return[...buckets].map(([index,indices])=>primitive.clone().setMaterial(mapping.materials[index]).setIndices(document.createAccessor().setType('SCALAR').setArray(new Uint32Array(indices)).setBuffer(primitive.getAttribute('POSITION')!.getBuffer())));
 }
 const items=prepared.primitives.flatMap(item=>split(item.primitive).map(primitive=>({...item,primitive})));
 prepared.primitives.splice(0,prepared.primitives.length,...items);
 for(const batch of prepared.instances){const mesh:Mesh=batch.mesh.clone();for(const original of mesh.listPrimitives()){mesh.removePrimitive(original);for(const primitive of split(original))mesh.addPrimitive(primitive);}batch.mesh=mesh;}
 return report;
}
