import{test}from'node:test';
import assert from'node:assert/strict';
import{Document}from'@gltf-transform/core';
import{KHRMaterialsSpecular,KHRMaterialsTransmission,KHRTextureTransform}from'@gltf-transform/extensions';
import sharp from'sharp';
import{readStaticConfig}from'../src/config.ts';
import{prepareStaticScene,mergeStaticScene}from'../src/static-scene.ts';
import{bakeMaterialAtlases}from'../src/material-atlas.ts';
import{ATLAS_EXTENSION,type AtlasMaterial}from'../src/atlas-extension.ts';
import{createIO}from'../src/io.ts';

test('atlas bake creates three shared materials, preserves wrapping and transmission partition, and round-trips',async context=>{
  const config=await readStaticConfig(new URL('../presets/pool.json',import.meta.url).pathname);
  config.instancing={enabled:false,minInstances:3,minSavedVertices:256};
  const doc=new Document(), buffer=doc.createBuffer();
  const plain=doc.createMaterial('plain').setBaseColorFactor([.2,.3,.4,1]).setMetallicFactor(.7).setRoughnessFactor(.6).setDoubleSided(true);
  plain.setExtension('KHR_materials_specular',doc.createExtension(KHRMaterialsSpecular).createSpecular().setSpecularFactor(.8));
  const patterned=doc.createMaterial('patterned').setBaseColorTexture(doc.createTexture('tile').setMimeType('image/png').setImage(await sharp({create:{width:16,height:16,channels:3,background:{r:180,g:90,b:30}}}).png().toBuffer()));
  patterned.getBaseColorTextureInfo()!.setExtension('KHR_texture_transform',doc.createExtension(KHRTextureTransform).createTransform().setScale([4,4]));
  const glass=doc.createMaterial('glass');
  glass.setExtension('KHR_materials_transmission',doc.createExtension(KHRMaterialsTransmission).createTransmission().setTransmissionFactor(.75));
  const make=(name:string,material:import('@gltf-transform/core').Material)=>doc.createNode(name).setMesh(doc.createMesh().addPrimitive(doc.createPrimitive().setMaterial(material)
    .setAttribute('POSITION',doc.createAccessor().setBuffer(buffer).setType('VEC3').setArray(new Float32Array([0,0,0,1,0,0,0,0,1])))
    .setAttribute('NORMAL',doc.createAccessor().setBuffer(buffer).setType('VEC3').setArray(new Float32Array([0,1,0,0,1,0,0,1,0])))
    .setAttribute('TEXCOORD_0',doc.createAccessor().setBuffer(buffer).setType('VEC2').setArray(new Float32Array([0,0,1,0,0,1])))));
  const scene=doc.createScene().addChild(make('surface',plain)).addChild(make('wall',patterned)).addChild(make('window',glass)).addChild(make('Ceiling',plain));
  const prepared=prepareStaticScene(doc,config);
  let result;
  try{result=await bakeMaterialAtlases(doc,prepared,config);}
  catch(error){if(/requires a hardware/.test(String(error))){context.skip('No hardware GPU');return;}throw error;}
  assert.equal(result.materials,3);assert.equal(result.regions,3);
  assert.equal(result.backend,'WebGPU');assert.equal(result.padding,16);
  const wall=prepared.primitives.find(item=>item.source==='wall')!.primitive;
  assert.deepEqual([...wall.getAttribute('TEXCOORD_0')!.getArray()!],[0,0,4,0,0,4]);
  const table=prepared.primitives.find(item=>item.source==='surface')!.primitive;
  const rectangle=table.getAttribute('_ATLAS_RECT')!.getElement(0,[]);
  const atlas=doc.getRoot().listTextures().find(texture=>texture.getName()==='atlas-msao')!;
  const {data,info}=await sharp(atlas.getImage()!).raw().toBuffer({resolveWithObject:true});
  const x=Math.round(rectangle[0]*info.width)+1,y=Math.round(rectangle[1]*info.height)+1;
  const values=[...data.slice((y*info.width+x)*4,(y*info.width+x)*4+4)];
  assert.deepEqual(values,[178,204,255,153]);
  await mergeStaticScene(doc,prepared);
  assert.equal(doc.getRoot().listMaterials().length,3);
  assert.equal(doc.getRoot().listTextures().length,4,'unused source textures and extension references are pruned');
  const environment=scene.listChildren().find(node=>node.getName()==='environment')!.getMesh()!;
  assert.equal(environment.listPrimitives().length,2);
  assert.equal(environment.listPrimitives().filter(p=>p.getExtras().optimizerTransmission).length,1);
  assert.equal(environment.listPrimitives()[0].getMaterial(),environment.listPrimitives()[1].getMaterial());
  const io=await createIO(), encoded=await io.writeBinary(doc),decoded=await io.readBinary(encoded);
  assert.equal(decoded.getRoot().listMaterials().length,3);
  assert.ok(decoded.getRoot().listExtensionsRequired().some(extension=>extension.extensionName===ATLAS_EXTENSION));
  for(const material of decoded.getRoot().listMaterials())assert.equal(material.getExtension<AtlasMaterial>(ATLAS_EXTENSION)!.getMetadata().padding,16);
});
