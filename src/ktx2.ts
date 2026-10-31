import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import type { Document, Texture } from '@gltf-transform/core';
import { KHRTextureBasisu } from '@gltf-transform/extensions';
import { getTextureColorSpace, listTextureInfo, listTextureSlots } from '@gltf-transform/functions';
import { planTextureSizes } from './texel-density.ts';
import type { Bounds, StaticPrimitive, StaticSceneConfig } from './static-scene.ts';

const execute = promisify(execFile);
export async function compressSceneTextures(document: Document, primitives: StaticPrimitive[], cameraBounds: Bounds, config: StaticSceneConfig) {
  await execute(config.textures.basisu,['-version'],{timeout:10000,maxBuffer:1024*1024}).catch(error => { throw new Error(`Cannot run Basis Universal encoder (${config.textures.basisu}): ${error.message}`); });
  const textures = document.getRoot().listTextures();
  const dimensions = new Map<Texture,{width:number;height:number}>();
  for (const texture of textures) {
    if (texture.getMimeType() === 'image/ktx2') throw new Error('Texture resizing currently requires original PNG/JPEG inputs, not already-compressed KTX2.');
    const metadata = await sharp(texture.getImage()!).metadata();
    if (!metadata.width || !metadata.height) throw new Error(`Missing dimensions: ${texture.getName()}`);
    dimensions.set(texture,{width:metadata.width,height:metadata.height});
  }
  const plans = planTextureSizes(primitives,dimensions,cameraBounds,config);
  for(const texture of textures)if(texture.getExtras().optimizerAtlas)plans.set(texture,dimensions.get(texture)!);
  const directory = await mkdtemp(join(tmpdir(),'glb-ktx2-'));
  const report: {name:string;before:number;after:number;sourceSize:number[];size:number[];codec:string;slots:string[]}[] = [];
  let next = 0;
  try {
    async function worker() {
      while (next < textures.length) {
        const index = next++;
        const texture = textures[index];
        const started = performance.now();
        const size = plans.get(texture)!, source = dimensions.get(texture)!;
        const slots = listTextureSlots(texture);
        const color = getTextureColorSpace(texture) === 'srgb';
        if (color && slots.some(slot => !/color|emissive|diffuse/i.test(slot))) throw new Error(`Texture used in both linear and sRGB slots: ${texture.getName()}. Split it before compression.`);
        const normal = slots.some(slot => /normal/i.test(slot));
        const png = join(directory,`${index}.png`), ktx = join(directory,`${index}.ktx2`);
        let image = sharp(texture.getImage()!);
        if (color) image = image.gamma();
        await image.resize(size.width,size.height,{fit:'fill',kernel:'lanczos3'}).png().toFile(png);
        const args = ['-file',png,'-output_file',ktx,'-ktx2','-mipmap','-max_threads',String(config.textures.threadsPerJob)];
        if (color) args.push('-etc1s','-q',String(config.textures.quality),'-comp_level','1');
        else args.push('-uastc','-uastc_level','2','-uastc_rdo_l','1.0','-linear');
        if(texture.getExtras().optimizerAtlas)args.push('-mip_filter','box');
        if (normal) args.push('-normal_map','-renorm','-mip_renorm');
        // Match the source wrap behavior at mip edges. Mixed wrap users use clamped
        // mip edges rather than introducing opposite-edge colors into clamped users.
        if (listTextureInfo(texture).some(info => info.getWrapS() !== 10497 || info.getWrapT() !== 10497)) args.push('-mip_clamp');
        await execute(config.textures.basisu,args,{timeout:120000,maxBuffer:2*1024*1024});
        const bytes = await readFile(ktx);
        const before = texture.getImage()!.byteLength;
        texture.setImage(bytes).setMimeType('image/ktx2').setURI('');
        report[index] = {name:texture.getName(),before,after:bytes.byteLength,sourceSize:[source.width,source.height],size:[size.width,size.height],codec:color?'ETC1S':'UASTC',slots};
        console.error(`KTX2 ${index+1}/${textures.length}: ${texture.getName()} ${size.width}×${size.height}, ${(bytes.byteLength/1024).toFixed(0)} KiB (${((performance.now()-started)/1000).toFixed(1)}s)`);
      }
    }
    // allSettled keeps the temporary directory alive until every in-flight child has stopped.
    const results = await Promise.allSettled(Array.from({length:Math.min(config.textures.jobs,textures.length)},worker));
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    document.createExtension(KHRTextureBasisu).setRequired(true);
    return report;
  } finally { await rm(directory,{recursive:true,force:true}); }
}
