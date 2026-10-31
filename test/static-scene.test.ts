import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Document} from '@gltf-transform/core';
import {KHRTextureTransform, KHRMaterialsSpecular} from '@gltf-transform/extensions';
import {prepareStaticScene,mergeStaticScene,textureBindings} from '../src/static-scene.ts';
import {boundsDistance,trianglePixelDensity,planTextureSizes} from '../src/texel-density.ts';
import {readStaticConfig} from '../src/config.ts';

const config = await readStaticConfig(new URL('../presets/pool.json',import.meta.url).pathname);
function fixture() {
  const doc = new Document(), buffer = doc.createBuffer();
  const texture = doc.createTexture('tile');
  const material = doc.createMaterial('wall').setBaseColorTexture(texture);
  const makeMesh = () => doc.createMesh().addPrimitive(doc.createPrimitive().setMaterial(material)
    .setAttribute('POSITION',doc.createAccessor().setType('VEC3').setArray(new Float32Array([0,0,0,1,0,0,0,1,0])).setBuffer(buffer))
    .setAttribute('NORMAL',doc.createAccessor().setType('VEC3').setArray(new Float32Array([0,0,1,0,0,1,0,0,1])).setBuffer(buffer))
    .setAttribute('TEXCOORD_0',doc.createAccessor().setType('VEC2').setArray(new Float32Array([0,0,1,0,0,1])).setBuffer(buffer)));
  const scene = doc.createScene();
  scene.addChild(doc.createNode('surface').setMesh(makeMesh()));
  const shared = makeMesh();
  scene.addChild(doc.createNode('wall1').setMesh(shared).setTranslation([5,0,0]));
  scene.addChild(doc.createNode('wall2').setMesh(shared).setTranslation([-5,0,0]).setScale([-1,1,1]));
  scene.addChild(doc.createNode('Ceiling').setMesh(makeMesh()).setTranslation([0,4,0]));
  const hidden = doc.createNode('hidden').setExtras({poolExportVisible:false}).addChild(doc.createNode('hidden mesh').setMesh(makeMesh()));
  scene.addChild(hidden);
  return {doc,texture,material};
}

test('world-space batching keeps separate passes and ceiling, handles shared meshes and negative scale',async () => {
  const {doc} = fixture();
  const prepared = prepareStaticScene(doc,config);
  assert.equal(prepared.removedHidden,1);
  assert.equal(prepared.primitives.length,4);
  assert.deepEqual(prepared.cameraBounds.min,[0,1.25,0]);
  assert.deepEqual(prepared.cameraBounds.max,[1,4,0]);
  await mergeStaticScene(doc,prepared);
  assert.deepEqual(doc.getRoot().listNodes().map(n=>n.getName()).toSorted(),['Ceiling','environment','table']);
  const mesh = doc.getRoot().listNodes().find(n=>n.getName()==='environment')!.getMesh()!;
  assert.equal(mesh.listPrimitives().length,1);
  assert.equal(doc.getRoot().listNodes().find(n=>n.getName()==='Ceiling')?.getExtras().optimizerCeiling,true);
  const walls = mesh.listPrimitives().find(p=>!p.getExtras().optimizerCeiling)!;
  const positions = walls.getAttribute('POSITION')!, indices=walls.getIndices()!;
  const x = Array.from({length:positions.getCount()},(_,i)=>positions.getElement(i,[])[0]);
  assert.equal(Math.min(...x),-6);assert.equal(Math.max(...x),6);
  for(let i=0;i<indices.getCount();i+=3){
    const [a,b,c]=[0,1,2].map(offset=>positions.getElement(indices.getScalar(i+offset),[]));
    const crossZ=(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
    assert.ok(crossZ>0,'negative transforms must preserve front-face winding');
  }
});
test('animated inputs are refused by static mode', () => {
  const {doc}=fixture();doc.createAnimation();assert.throws(()=>prepareStaticScene(doc,config),/animations/);
});
test('density accounts for tiling and the largest stretching direction', () => {
  const points = [[0,0,0],[1,0,0],[0,1,0]];
  assert.equal(trianglePixelDensity(points,[[0,0],[1,0],[0,1]],1024,1024),1024);
  assert.equal(trianglePixelDensity(points,[[0,0],[4,0],[0,1]],1024,1024),4096);
  assert.equal(trianglePixelDensity([[0,0,0],[0,0,0],[0,1,0]],[[0,0],[1,0],[0,1]],1024,1024),0);
  assert.equal(boundsDistance({min:[-1,-1,-1],max:[1,1,1]},{min:[4,-1,-1],max:[6,1,1]}),3);
});
test('texture transform and extension-owned slots participate in density planning', () => {
  const {doc,texture,material}=fixture();
  const extension = doc.createExtension(KHRTextureTransform);
  material.getBaseColorTextureInfo()!.setExtension('KHR_texture_transform',extension.createTransform().setScale([4,4]));
  const specTexture = doc.createTexture('specular');
  const specular = doc.createExtension(KHRMaterialsSpecular).createSpecular().setSpecularTexture(specTexture);
  material.setExtension('KHR_materials_specular',specular);
  assert.equal(textureBindings(material).length,2);
  const prepared = prepareStaticScene(doc,config);
  const plans = planTextureSizes(prepared.primitives,new Map([[texture,{width:1024,height:1024}],[specTexture,{width:1024,height:1024}]]),prepared.cameraBounds,config);
  assert.deepEqual(plans.get(texture),{width:128,height:128});
  assert.deepEqual(plans.get(specTexture),{width:512,height:512});
});

test('opaque repeated furniture is instanced separately, with original world transforms',async () => {
  const {doc}=fixture();
  const scene=doc.getRoot().listScenes()[0];
  const original=doc.getRoot().listNodes().find(n=>n.getName()==='wall1')!;
  scene.addChild(doc.createNode('repeat2').setMesh(original.getMesh()).setTranslation([7,0,0]));
  scene.addChild(doc.createNode('repeat3').setMesh(original.getMesh()).setTranslation([9,0,0]));
  const parent=doc.createNode('rotated parent').setScale([2,1,1]);
  parent.addChild(doc.createNode('sheared repeat').setMesh(original.getMesh()).setRotation([0,0,Math.sin(Math.PI/8),Math.cos(Math.PI/8)]));
  scene.addChild(parent);
  const prepared=prepareStaticScene(doc,{...config,instancing:{enabled:true,minInstances:3,minSavedVertices:0}});
  assert.equal(prepared.instances.length,1);
  assert.deepEqual(prepared.instances[0].nodes.map(n=>n.getName()),['wall1','repeat2','repeat3']);
  const result=await mergeStaticScene(doc,prepared);
  assert.equal(result.instancing.instances,3);
  const node=doc.getRoot().listNodes().find(n=>n.getExtension('EXT_mesh_gpu_instancing'))!;
  assert.equal(node.getParentNode()?.getName(),'environment');
  const ext=node.getExtension<import('@gltf-transform/extensions').InstancedMesh>('EXT_mesh_gpu_instancing')!;
  assert.deepEqual(Array.from(ext.getAttribute('TRANSLATION')!.getArray()!),[5,0,0,7,0,0,9,0,0]);
  assert.ok(doc.getRoot().listExtensionsRequired().some(ext=>ext.extensionName==='EXT_mesh_gpu_instancing'));
});

test('transmission materials are excluded from instancing',()=>{
  const {doc,material}=fixture();
  // Alpha blending is also enough to require independent sorting.
  material.setAlphaMode('BLEND');
  const prepared=prepareStaticScene(doc,{...config,instancing:{enabled:true,minInstances:2,minSavedVertices:0}});
  assert.equal(prepared.instances.length,0);
});
