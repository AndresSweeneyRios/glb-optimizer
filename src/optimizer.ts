import { rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Document } from '@gltf-transform/core';
import { dedup, reorder, draco } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import { createIO } from './io.ts';
import {prepareStaticScene, mergeStaticScene, type StaticSceneConfig} from './static-scene.ts';
import {bakeMaterialAtlases} from './material-atlas.ts';
import {OptimizerAtlasExtension} from './atlas-extension.ts';
import {compressSceneTextures} from './ktx2.ts';

export function summarize(document: Document) {
  const root = document.getRoot();
  const primitives = root.listMeshes().flatMap(mesh => mesh.listPrimitives());
  return {
    scenes: root.listScenes().length,
    nodes: root.listNodes().length,
    meshes: root.listMeshes().length,
    primitives: primitives.length,
    vertices: primitives.reduce((sum, p) => sum + (p.getAttribute('POSITION')?.getCount() ?? 0), 0),
    materials: root.listMaterials().length,
    textures: root.listTextures().length,
    textureBytes: root.listTextures().reduce((sum, texture) => sum + (texture.getImage()?.byteLength ?? 0), 0),
    skins: root.listSkins().length,
    morphTargets: primitives.reduce((sum, p) => sum + p.listTargets().length, 0),
    animations: root.listAnimations().length,
    extensions: root.listExtensionsUsed().map(extension => extension.extensionName),
  };
}

export async function inspect(input: string) {
  const io = await createIO();
  return { path: resolve(input), bytes: (await stat(input)).size, ...summarize(await io.read(input)) };
}

export async function optimize(input: string, output: string, config?: StaticSceneConfig) {
  const started = performance.now();
  if (resolve(input) === resolve(output)) throw new Error('Input and output must be different files.');
  const io = await createIO();
  // Unknown extensions are refused rather than silently discarded on write.
  const json = await io.readAsJSON(input);
  const supported = new Set(Object.values(await import('@gltf-transform/extensions'))
    .map(value => (value as { EXTENSION_NAME?: string }).EXTENSION_NAME).filter(Boolean));
  supported.add(OptimizerAtlasExtension.EXTENSION_NAME);
  for (const extension of json.json.extensionsUsed ?? []) {
    if (!supported.has(extension)) throw new Error(`Unsupported extension: ${extension}. Refusing a lossy round trip.`);
  }
  const document = await io.read(input);
  const before = summarize(document);
  let staticScene;
  if (config) {
    await document.transform(dedup({propertyTypes:['Accessor','Texture','Material','Mesh']}));
    const prepared = prepareStaticScene(document,config);
    let atlas;
    let textures;
    let geometry;
    if(config.atlas?.enabled) {
      atlas=await bakeMaterialAtlases(document,prepared,config);
      geometry=await mergeStaticScene(document,prepared);
      textures=await compressSceneTextures(document,[],prepared.cameraBounds,config);
    } else {
      textures=await compressSceneTextures(document,prepared.primitives,prepared.cameraBounds,config);
      geometry=await mergeStaticScene(document,prepared);
    }
    staticScene = {cameraBounds:prepared.cameraBounds,tableBounds:prepared.tableBounds,textures,...geometry,...(atlas?{atlas}:{})};
    await document.transform(dedup({keepUniqueNames:!!config.atlas?.enabled}),reorder({encoder:MeshoptEncoder}),draco({quantizePosition:16,quantizeNormal:12,quantizeTexcoord:16,quantizeGeneric:20,encodeSpeed:5,decodeSpeed:5}));
  } else {
    // Conservative mode retains the scene hierarchy and all animated resources.
    await document.transform(dedup({ propertyTypes: ['Accessor', 'Texture', 'Material'] }), reorder({ encoder: MeshoptEncoder }));
  }
  const temporary = resolve(dirname(output), `.${randomUUID()}.glb`);
  try {
    await io.write(temporary, document);
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
  return { input: resolve(input), output: resolve(output), before, after: summarize(document), bytes: (await stat(output)).size, milliseconds: Math.round(performance.now()-started), ...(staticScene ? {staticScene} : {}) };
}
