import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import sharp from 'sharp';
import {Document} from '@gltf-transform/core';
import {read as readKTX, KHR_DF_MODEL_ETC1S, KHR_DF_MODEL_UASTC, KHR_DF_TRANSFER_LINEAR, KHR_DF_TRANSFER_SRGB} from 'ktx-parse';
import {readStaticConfig} from '../src/config.ts';
import {prepareStaticScene} from '../src/static-scene.ts';
import {compressSceneTextures} from '../src/ktx2.ts';
import {createIO} from '../src/io.ts';

test('real KTX2 encoding preserves color spaces, dimensions, mip chains and glTF extension',async context => {
  try {await promisify(execFile)('basisu',['-version'],{timeout:10000});}
  catch {context.skip('basisu is not installed');return;}
  const config=await readStaticConfig(new URL('../presets/pool.json',import.meta.url).pathname);
  const doc=new Document(), buffer=doc.createBuffer();
  const color=doc.createTexture('color').setImage(await sharp({create:{width:16,height:16,channels:4,background:{r:255,g:80,b:20,alpha:0.5}}}).png().toBuffer()).setMimeType('image/png');
  const normal=doc.createTexture('normal').setImage(await sharp({create:{width:16,height:16,channels:3,background:{r:128,g:128,b:255}}}).png().toBuffer()).setMimeType('image/png');
  const material=doc.createMaterial().setBaseColorTexture(color).setNormalTexture(normal);
  const primitive=doc.createPrimitive().setMaterial(material)
    .setAttribute('POSITION',doc.createAccessor().setType('VEC3').setArray(new Float32Array([0,0,0,1,0,0,0,0,1])).setBuffer(buffer))
    .setAttribute('TEXCOORD_0',doc.createAccessor().setType('VEC2').setArray(new Float32Array([0,0,1,0,0,1])).setBuffer(buffer));
  doc.createScene().addChild(doc.createNode('surface').setMesh(doc.createMesh().addPrimitive(primitive)));
  const prepared=prepareStaticScene(doc,config);
  await compressSceneTextures(doc,prepared.primitives,prepared.cameraBounds,config);
  for(const [texture,model,transfer] of [[color,KHR_DF_MODEL_ETC1S,KHR_DF_TRANSFER_SRGB],[normal,KHR_DF_MODEL_UASTC,KHR_DF_TRANSFER_LINEAR]] as const){
    const ktx=readKTX(texture.getImage()!);
    assert.equal(ktx.pixelWidth,16);assert.equal(ktx.pixelHeight,16);
    assert.equal(ktx.levels.length,5);
    assert.equal(ktx.dataFormatDescriptor[0].colorModel,model);
    assert.equal(ktx.dataFormatDescriptor[0].transferFunction,transfer);
    assert.ok(ktx.levels.every(level=>level.levelData.byteLength>0));
  }
  assert.equal(readKTX(color.getImage()!).dataFormatDescriptor[0].samples.length,2,'ETC1S retains an alpha slice');
  const io=await createIO();
  const result=await io.binaryToJSON(await io.writeBinary(doc));
  assert.ok(result.json.extensionsRequired?.includes('KHR_texture_basisu'));
  assert.ok(result.json.images?.every(image=>image.mimeType==='image/ktx2'));
});
