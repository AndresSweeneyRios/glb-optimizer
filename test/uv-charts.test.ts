import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Document} from '@gltf-transform/core';
import {readStaticConfig} from '../src/config.ts';
import {prepareStaticScene} from '../src/static-scene.ts';
import {splitUVCharts} from '../src/uv-charts.ts';
import {triangleBoxDistance} from '../src/geometry-distance.ts';
import {planTextureSizes} from '../src/texel-density.ts';
import {clipPrimitiveToRegions} from '../src/uv-clip.ts';
import {coverageRectangles,createUVCoverageGPU,partitionCoverage} from '../src/uv-coverage.ts';

const config=await readStaticConfig(new URL('../presets/pool.json',import.meta.url).pathname);
delete config.camera.box;
const layout={texCoord:0,scale:[1,1],offset:[0,0],rotation:0,wrapS:10497,wrapT:10497};
function fixture(uv:number[]){
 const doc=new Document(),buffer=doc.createBuffer(),texture=doc.createTexture(),material=doc.createMaterial('sheet').setBaseColorTexture(texture);
 const primitive=doc.createPrimitive().setMaterial(material)
  .setAttribute('POSITION',doc.createAccessor().setType('VEC3').setArray(new Float32Array(uv.flatMap((_,i)=>i%2?[]:[uv[i],0,uv[i+1]]))).setBuffer(buffer))
  .setAttribute('NORMAL',doc.createAccessor().setType('VEC3').setArray(new Float32Array(uv.flatMap((_,i)=>i%2?[]:[0,1,0]))).setBuffer(buffer))
  .setAttribute('TEXCOORD_0',doc.createAccessor().setType('VEC2').setArray(new Float32Array(uv)).setBuffer(buffer));
 doc.createScene().addChild(doc.createNode('surface').setMesh(doc.createMesh().addPrimitive(primitive)));
 return {doc,texture,primitive,prepared:prepareStaticScene(doc,config)};
}
async function referenceRaster(triangles:number[][][],width:number,height:number){
 const result=new Uint8Array(width*height);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(triangles.some(t=>triangleBoxDistance(t.map(p=>[...p,0]),{min:[x/width,y/height,0],max:[(x+1)/width,(y+1)/height,0]})<1e-12))result[y*width+x]=1;
 return result;
}
function area(primitives:import('@gltf-transform/core').Primitive[]){
 let sum=0;
 for(const primitive of primitives){const position=primitive.getAttribute('POSITION')!,indices=primitive.getIndices();for(let i=0;i<(indices?.getCount()??position.getCount());i+=3){const[a,b,c]=[0,1,2].map(j=>position.getElement(indices?indices.getScalar(i+j):i+j,[]));sum+=Math.abs((b[0]-a[0])*(c[2]-a[2])-(b[2]-a[2])*(c[0]-a[0]))/2;}}
 return sum;
}
test('distance is to the triangle, not its bounding box or object origin',()=>{
 const triangle=[[0,0,0],[10,0,0],[0,0,10]],box={min:[8.9,-.1,8.9],max:[9.1,.1,9.1]};
 assert.ok(Math.abs(triangleBoxDistance(triangle,box)-7.8/Math.sqrt(2))<1e-10);
 assert.equal(triangleBoxDistance(triangle,{min:[1,-.1,1],max:[2,.1,2]}),0);
});
test('connected L-shaped UV charts cut out their unused interior and preserve geometry',async()=>{
 const a=[.05,.05],b=[.95,.05],c=[.95,.2],d=[.2,.2],e=[.05,.2],f=[.2,.95],g=[.05,.95];
 const{doc,prepared}=fixture([a,b,c,a,c,d,a,d,e,e,d,f,e,f,g].flat());
 const before=area(prepared.primitives.map(item=>item.primitive));
 const report=await splitUVCharts(doc,prepared,()=>layout,()=>({width:1024,height:1024}),16,referenceRaster);
 assert.ok(report[0].charts>1);
 assert.ok(report[0].usedArea<.5,'must not retain the 0.81-area bounding rectangle');
 assert.ok(Math.abs(area(prepared.primitives.map(item=>item.primitive))-before)<1e-7);
});
test('repeated UVs retain one full tile',async()=>{
 const{doc,prepared}=fixture([0,0,2,0,0,2,2,0,3,0,2,1]);
 const report=await splitUVCharts(doc,prepared,()=>layout,()=>({width:1024,height:1024}),16,referenceRaster);
 assert.equal(prepared.primitives.length,1);assert.match(report[0].skipped!,/Repeated/);
});
test('UV clipping interpolates positions and normals without changing surface area',()=>{
 const{doc,primitive}=fixture([0,0,1,0,0,1]);
 primitive.getAttribute('NORMAL')!.setArray(new Float32Array([1,0,0,0,1,0,0,0,1]));
 const result=clipPrimitiveToRegions(doc,primitive,layout,[{rect:[0,0,.5,1],material:doc.createMaterial()},{rect:[.5,0,.5,1],material:doc.createMaterial()}]);
 assert.ok(Math.abs(area(result)-.5)<1e-10);
 assert.ok(result.reduce((sum,p)=>sum+p.getAttribute('POSITION')!.getCount(),0)>3);
 for(const p of result)for(let i=0;i<p.getAttribute('POSITION')!.getCount();i++){const point=p.getAttribute('POSITION')!.getElement(i,[]),normal=p.getAttribute('NORMAL')!.getElement(i,[]);assert.ok(Math.abs(normal[0]-(1-point[0]-point[2]))<1e-7);assert.equal(normal[1],point[0]);assert.equal(normal[2],point[2]);}
});
test('UV lines on rectangle boundaries are not duplicated',()=>{
 const{doc,primitive}=fixture([0,0,1,0,0,1]);primitive.getAttribute('TEXCOORD_0')!.setArray(new Float32Array([0,.5,1,.5,0,.5]));
 const result=clipPrimitiveToRegions(doc,primitive,layout,[{rect:[0,0,1,.5],material:doc.createMaterial()},{rect:[0,.5,1,.5],material:doc.createMaterial()}]);
 assert.equal(result.length,1);assert.equal(area(result),.5);
});
test('GPU coverage conservatively matches an independent closest-feature reference',async context=>{
 let gpu;try{gpu=await createUVCoverageGPU();}catch(error){if(/requires a hardware/.test(String(error))){context.skip('No hardware GPU');return;}throw error;}
 try{const triangles=[[[.1,.2],[.85,.25],[.23,.9]],[[.5,.5],[.5,.5],[.5,.5]]];assert.deepEqual(await gpu.rasterize(triangles,16,16),await referenceRaster(triangles,16,16));}
 finally{gpu.destroy();}
});
test('rectangle cover includes all occupied cells exactly once',()=>{
 const mask=new Uint8Array([1,1,0,0,1,1,0,0,1,0,1,1]),covered=new Uint8Array(mask.length);
 for(const[x,y,w,h]of coverageRectangles(mask,4,3))for(let row=Math.round(y*3);row<Math.round((y+h)*3);row++)for(let col=Math.round(x*4);col<Math.round((x+w)*4);col++)covered[row*4+col]++;
 assert.deepEqual(covered,mask);
});
test('subpixel float noise around a constant UV does not demand a full-resolution map',()=>{
 const{prepared,texture}=fixture([0,0,1,0,0,1]);prepared.primitives[0].primitive.getAttribute('TEXCOORD_0')!.setArray(new Float32Array([0,0,0,1e-7,0,0]));
 const plan=planTextureSizes(prepared.primitives,new Map([[texture,{width:1024,height:1024}]]),prepared.cameraBounds,config);
 assert.deepEqual(plan.get(texture),{width:32,height:32});
});

test('padding-aware partition preserves occupancy without overlaps and avoids tiny patches',()=>{
 const mask=new Uint8Array(32*32);for(let y=0;y<32;y++)for(let x=0;x<32;x++)if(x<6||y<6)mask[y*32+x]=1;
 const cost=(r:number[])=>(Math.ceil(r[2]*1024/16)*16+32)*(Math.ceil(r[3]*1024/16)*16+32);
 const regions=partitionCoverage(mask,32,32,cost),covered=new Uint8Array(mask.length);
 for(const[x,y,w,h]of regions)for(let row=Math.round(y*32);row<Math.round((y+h)*32);row++)for(let col=Math.round(x*32);col<Math.round((x+w)*32);col++)covered[row*32+col]++;
 assert.equal(regions.length,2);assert.deepEqual(covered,mask);
 assert.ok(regions.reduce((sum,r)=>sum+cost(r),0)<cost([0,0,1,1])*.5);
});
test('camera box is centered on the table, independent of its full footprint',()=>{
 const {doc}=fixture([0,0,1,0,0,1]);
 const prepared=prepareStaticScene(doc,{...config,camera:{...config.camera,box:{center:[0,.8,0],size:[.4,.8,.4]}}});
 for(let axis=0;axis<3;axis++)assert.ok(Math.abs(prepared.cameraBounds.max[axis]-prepared.cameraBounds.min[axis]-[.4,.8,.4][axis])<1e-10);
 assert.deepEqual(prepared.cameraBounds.min,[.3,.4,.3]);
});
