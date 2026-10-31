import type {Document,Material,Mesh,Primitive} from '@gltf-transform/core';
import type {prepareStaticScene} from './static-scene.ts';
import {createUVCoverageGPU,partitionCoverage} from './uv-coverage.ts';
import {clipPrimitiveToRegions,triangleUVs} from './uv-clip.ts';

export interface ChartUV {texCoord:number;scale:number[];offset:number[];rotation:number;wrapS:number;wrapT:number}
type Prepared=ReturnType<typeof prepareStaticScene>;
type Size={width:number;height:number;targetWidth?:number;targetHeight?:number};
type Rasterizer=(triangles:number[][][],width:number,height:number)=>Promise<Uint8Array>;

/** Cut occupied UV regions out of source sheets, including holes inside connected islands. */
export async function splitUVCharts(document:Document,prepared:Prepared,layoutFor:(material:Material)=>ChartUV,sourceSize:(material:Material)=>Size|null,padding:number,rasterize?:Rasterizer){
 const groups=new Map<Material,Primitive[]>();
 for(const item of prepared.primitives){const material=item.primitive.getMaterial();if(!material)continue;const group=groups.get(material)??[];group.push(item.primitive);groups.set(material,group);}
 const mappings=new Map<Material,{regions:{rect:number[];material:Material}[];layout:ChartUV}>();
 const report:{material:string;charts:number;usedArea:number;coverage?:number;skipped?:string}[]=[];
 let gpu:Awaited<ReturnType<typeof createUVCoverageGPU>>|undefined;
 try {
  for(const[material,primitives]of groups){
   const size=sourceSize(material);if(!size)continue;
   const layout=layoutFor(material),unique=new Map<string,number[][]>();
   for(const primitive of primitives)for(const triangle of triangleUVs(primitive,layout))unique.set(triangle.key,triangle.uv);
   const triangles=[...unique.values()];
   if(!triangles.length||triangles.some(t=>t.some(uv=>uv.some(value=>value< -1e-5||value>1+1e-5)))){report.push({material:material.getName(),charts:1,usedArea:1,skipped:'Repeated UVs: full tile retained'});continue;}
   if(!rasterize&&!gpu)gpu=await createUVCoverageGPU();
   const width=32,height=Math.max(4,Math.round(width*size.height/size.width));
   const mask=await(rasterize??gpu!.rasterize)(triangles,width,Math.min(128,height));
   const coverage=mask.reduce((sum,value)=>sum+Number(value!==0),0)/mask.length;
   const crop=(rect:number[])=>{
    const left=Math.max(0,Math.floor(rect[0]*size.width)-2),top=Math.max(0,Math.floor(rect[1]*size.height)-2);
    const right=Math.min(size.width,Math.ceil((rect[0]+rect[2])*size.width)+2),bottom=Math.min(size.height,Math.ceil((rect[1]+rect[3])*size.height)+2);
    return[left/size.width,top/size.height,(right-left)/size.width,(bottom-top)/size.height];
   };
   const targetWidth=size.targetWidth??size.width,targetHeight=size.targetHeight??size.height;
   const cost=(rect:number[])=>{const width=Math.ceil(Math.max(16,rect[2]*targetWidth)/16)*16,height=Math.ceil(Math.max(16,rect[3]*targetHeight)/16)*16;return(width+2*padding)*(height+2*padding);};
   const cores=partitionCoverage(mask,width,Math.min(128,height),rect=>cost(crop(rect)));
   if(!cores.length)throw new Error(`No UV coverage found for ${material.getName()}`);
   const crops=cores.map(crop);
   const totalCost=crops.reduce((sum,rect)=>sum+cost(rect),0);
   if(cores.length>128||totalCost>=cost([0,0,1,1])*.97){report.push({material:material.getName(),charts:1,usedArea:1,coverage,skipped:'Occupied regions do not save space after bleed'});continue;}
   const regions=cores.map((rect,index)=>({rect,material:material.clone().setName(`${material.getName()} patch ${index+1}`).setExtras({...material.getExtras(),optimizerUVRect:crops[index],optimizerSourceMaterial:material.getName()})}));
   mappings.set(material,{regions,layout});
   report.push({material:material.getName(),charts:regions.length,usedArea:crops.reduce((sum,rect)=>sum+rect[2]*rect[3],0),coverage});
  }
 }finally{gpu?.destroy();}
 function split(primitive:Primitive){
  const mapping=mappings.get(primitive.getMaterial()!);
  return mapping?clipPrimitiveToRegions(document,primitive,mapping.layout,mapping.regions):[primitive];
 }
 const items=prepared.primitives.flatMap(item=>split(item.primitive).map(primitive=>({...item,primitive})));
 prepared.primitives.splice(0,prepared.primitives.length,...items);
 for(const batch of prepared.instances){const mesh:Mesh=batch.mesh.clone();for(const original of mesh.listPrimitives()){mesh.removePrimitive(original);for(const primitive of split(original))mesh.addPrimitive(primitive);}batch.mesh=mesh;}
 return report;
}
