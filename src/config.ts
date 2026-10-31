import {readFile} from 'node:fs/promises';
import type {StaticSceneConfig} from './static-scene.ts';
export async function readStaticConfig(path: string): Promise<StaticSceneConfig> {
  const value = JSON.parse(await readFile(path,'utf8'));
  if (!value || !Array.isArray(value.tableNames) || !Array.isArray(value.tablePrefixes) || ![...value.tableNames,...value.tablePrefixes].every(x=>typeof x==='string' && x.length)) throw new Error('Config requires tableNames and tablePrefixes string arrays.');
  const check = (group: string, key: string, min: number, max: number, integer=false) => {
    const number = value[group]?.[key];
    if (typeof number !== 'number' || !Number.isFinite(number) || number < min || number > max || (integer && !Number.isSafeInteger(number))) throw new Error(`Invalid config ${group}.${key}: expected ${min}–${max}${integer?' integer':''}.`);
  };
  check('camera','minimumHeight',0,1000); check('camera','maximumHeight',0.001,1000);
  check('camera','verticalFov',1,179);check('camera','viewportHeight',1,16384,true);
  check('camera','oversampling',0.1,8);check('camera','minimumDistance',0.001,1000);
  check('textures','tableTexelsPerMeter',1,16384);check('textures','environmentTexelsPerMeter',1,16384);
  check('textures','maxSize',4,16384,true);check('textures','minSize',4,16384,true);
  check('textures','quality',1,255,true);check('textures','jobs',1,32,true);check('textures','threadsPerJob',1,64,true);
  if (value.textures.minSize>value.textures.maxSize || value.textures.minSize%4 || value.textures.maxSize%4 || value.camera.minimumHeight>=value.camera.maximumHeight || typeof value.textures.basisu !== 'string' || !value.textures.basisu) throw new Error('Invalid size limits, camera heights or basisu executable.');
  if (value.instancing !== undefined) {
    if (typeof value.instancing?.enabled !== 'boolean') throw new Error('Invalid config instancing.enabled.');
    check('instancing','minInstances',2,100000,true);check('instancing','minSavedVertices',0,100000000,true);
  }
  if(value.atlas!==undefined) {
    if(typeof value.atlas?.enabled!=='boolean')throw new Error('Invalid config atlas.enabled.');
    check('atlas','padding',16,256,true);check('atlas','maxSize',64,4096,true);
    if((value.atlas.padding&(value.atlas.padding-1)) || value.atlas.maxSize%16)throw new Error('Atlas padding must be a power of two; maxSize must be divisible by 16.');
  }
  if(value.textures.materialTexelsPerMeter!==undefined && (!value.textures.materialTexelsPerMeter || typeof value.textures.materialTexelsPerMeter!=='object' || Array.isArray(value.textures.materialTexelsPerMeter) || Object.values(value.textures.materialTexelsPerMeter).some(n=>typeof n!=='number'||!Number.isFinite(n)||n<1||n>16384)))throw new Error('Invalid per-material texel density budget.');
  return value as StaticSceneConfig;
}
