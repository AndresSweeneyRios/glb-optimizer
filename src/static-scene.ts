import { ExtensionProperty, Material, Texture, TextureInfo, MathUtils, type Document, type Mesh, type Node, type Primitive, type mat4, type vec3, type vec4 } from '@gltf-transform/core';
import { EXTMeshGPUInstancing } from '@gltf-transform/extensions';
import { getBounds, joinPrimitives, prune, transformMesh } from '@gltf-transform/functions';

export interface Bounds { min: number[]; max: number[] }
export type RenderPass = 'table' | 'environment';
export interface StaticSceneConfig {
  tableNames: string[];
  tablePrefixes: string[];
  atlas?: {enabled: boolean; padding: number; maxSize: number};
  instancing?: {enabled: boolean; minInstances: number; minSavedVertices: number};
  camera: { minimumHeight: number; maximumHeight: number; verticalFov: number; viewportHeight: number; oversampling: number; minimumDistance: number };
  textures: { tableTexelsPerMeter: number; environmentTexelsPerMeter: number; maxSize: number; minSize: number; quality: number; jobs: number; threadsPerJob: number; basisu: string };
}
export interface StaticPrimitive { primitive: Primitive; pass: RenderPass; ceiling: boolean; source: string; instanceBatch?: number; transmission?: boolean }

export function classifyNode(node: Node, config: StaticSceneConfig): RenderPass {
  for (let parent: Node | null = node; parent; parent = parent.getParentNode()) {
    if (config.tableNames.includes(parent.getName()) || config.tablePrefixes.some(prefix => parent!.getName().startsWith(prefix))) return 'table';
  }
  return 'environment';
}
function isVisible(node: Node) {
  for (let parent: Node | null = node; parent; parent = parent.getParentNode()) if (parent.getExtras().poolExportVisible === false) return false;
  return true;
}
function isCeiling(node: Node) {
  for (let parent: Node | null = node; parent; parent = parent.getParentNode()) if (parent.getName() === 'Ceiling') return true;
  return false;
}

export function prepareStaticScene(document: Document, config: StaticSceneConfig) {
  const root = document.getRoot();
  if (root.listScenes().length !== 1) throw new Error('Static scene preset requires exactly one scene.');
  if (root.listAnimations().length || root.listSkins().length || root.listMeshes().some(mesh => mesh.listPrimitives().some(p => p.listTargets().length))) throw new Error('Static merging refuses animations, skinning and morph targets.');
  if (root.listNodes().some(node => node.getExtension('EXT_mesh_gpu_instancing'))) throw new Error('Expand instanced geometry before static merging.');
  const sourceNodes = root.listNodes();
  const instances = findInstanceBatches(sourceNodes,config);
  const instanceNodes = new Map<Node,number>();
  instances.forEach((batch,index)=>batch.nodes.forEach(node=>instanceNodes.set(node,index)));
  const tableBounds: Bounds = { min: [Infinity,Infinity,Infinity], max: [-Infinity,-Infinity,-Infinity] };
  const primitives: StaticPrimitive[] = [];
  let removedHidden = 0;
  for (const node of sourceNodes) {
    const original = node.getMesh();
    if (!original) continue;
    if (!isVisible(node)) { removedHidden++; continue; }
    const pass = classifyNode(node, config);
    if (pass === 'table') {
      const bounds = getBounds(node);
      for (let i = 0; i < 3; i++) { tableBounds.min[i] = Math.min(tableBounds.min[i], bounds.min[i]); tableBounds.max[i] = Math.max(tableBounds.max[i], bounds.max[i]); }
    }
    const mesh = original.clone();
    transformMesh(mesh, node.getWorldMatrix());
    for (const primitive of mesh.listPrimitives()) {
      if (primitive.getMode() !== 4) throw new Error(`Static preset supports triangles only: ${node.getName()}`);
      if (primitive.listExtensions().length) throw new Error(`Unsupported primitive extension: ${node.getName()}`);
      primitives.push({primitive,pass,ceiling:isCeiling(node),source:node.getName(),instanceBatch:instanceNodes.get(node)});
    }
    mesh.dispose();
  }
  if (!tableBounds.min.every(Number.isFinite)) throw new Error('No table geometry matched the configured names.');
  const cameraBounds = {
    min: [tableBounds.min[0], tableBounds.max[1] + config.camera.minimumHeight, tableBounds.min[2]],
    max: [tableBounds.max[0], tableBounds.max[1] + config.camera.maximumHeight, tableBounds.max[2]],
  };
  return {primitives, tableBounds, cameraBounds, sourceNodes, removedHidden, instances};
}

export async function mergeStaticScene(document: Document, prepared: ReturnType<typeof prepareStaticScene>) {
  const root = document.getRoot();
  const scene = root.listScenes()[0];
  const materials = root.listMaterials();
  const groups = {table:new Map<string,StaticPrimitive[]>(),environment:new Map<string,StaticPrimitive[]>(),ceiling:new Map<string,StaticPrimitive[]>()};
  for (const item of prepared.primitives) {
    if (item.instanceBatch !== undefined) continue;
    const primitive = item.primitive;
    const key = JSON.stringify({ material: materials.indexOf(primitive.getMaterial()!), mode: primitive.getMode(), ceiling: item.ceiling, transmission: item.transmission??false,
      attributes: primitive.listSemantics().toSorted().map(semantic => { const a = primitive.getAttribute(semantic)!; return [semantic,a.getType(),a.getComponentType(),a.getNormalized()]; }) });
    const group = groups[item.ceiling?'ceiling':item.pass];
    const bucket = group.get(key) ?? [];
    bucket.push(item); group.set(key,bucket);
  }
  // Save instance world transforms before removing the original parents.
  const transforms = prepared.instances.map(batch=>batch.nodes.map(node=>({name:node.getName(),matrix:node.getWorldMatrix()})));
  // Geometry is already in world coordinates. Replace the source hierarchy only after baking.
  for (const node of prepared.sourceNodes) node.dispose();
  const report = [];
  let environmentNode: Node | undefined;
  for (const group of ['table','environment','ceiling'] as const) {
    if (!groups[group].size && group === 'ceiling') continue;
    const pass = group === 'ceiling'?'environment':group;
    const mesh = document.createMesh(`${group}-merged`);
    for (const bucket of groups[group].values()) {
      const primitive = bucket.length === 1 ? bucket[0].primitive : joinPrimitives(bucket.map(item => item.primitive));
      primitive.setExtras({optimizerPass:pass,optimizerCeiling:bucket[0].ceiling,optimizerTransmission:bucket[0].transmission??false,sourceNames:[...new Set(bucket.map(item => item.source))]});
      mesh.addPrimitive(primitive);
    }
    const node = document.createNode(group === 'ceiling'?'Ceiling':group).setMesh(mesh).setExtras({optimizerPass:pass,optimizerCeiling:group==='ceiling'});
    if (group === 'environment') environmentNode = node;
    scene.addChild(node);
    report.push({group,pass,meshes:1,materialBatches:mesh.listPrimitives().length});
  }
  const instancing = createInstanceNodes(document,prepared.instances,transforms,environmentNode!);
  scene.setExtras({...scene.getExtras(),optimizer:{version:1,tableBounds:prepared.tableBounds,cameraBounds:prepared.cameraBounds}});
  await document.transform(prune({keepAttributes:true,keepLeaves:false,keepSolidTextures:true}));
  // Disposed source materials can leave extension-owned texture references alive.
  // Keep only properties reaching one of the remaining output materials.
  const keptMaterials=new Set(root.listMaterials());
  const isAttached=(property: import('@gltf-transform/core').Property): boolean=>{
    const visited=new Set<import('@gltf-transform/core').Property>();
    const pending=[property];
    while(pending.length){const current=pending.pop()!;if(visited.has(current))continue;visited.add(current);if(current instanceof Material&&keptMaterials.has(current))return true;pending.push(...current.listParents());}
    return false;
  };
  for(const extension of root.listExtensionsUsed()) {
    if(!['KHR_materials_specular','KHR_materials_ior','KHR_materials_transmission','KHR_materials_emissive_strength','KHR_texture_transform','EXT_glb_optimizer_atlas'].includes(extension.extensionName))continue;
    for(const property of extension.listProperties())if(!isAttached(property))property.dispose();
    if(!extension.listProperties().length)extension.dispose();
  }
  await document.transform(prune({keepAttributes:true,keepLeaves:false,keepSolidTextures:true}));
  return {groups:report,removedHiddenMeshes:prepared.removedHidden,instancing};
}

interface InstanceBatch {mesh: Mesh; nodes: Node[]; vertices: number}
function findInstanceBatches(nodes: Node[], config: StaticSceneConfig): InstanceBatch[] {
  if (!config.instancing?.enabled) return [];
  const groups = new Map<Mesh,Node[]>();
  for (const node of nodes) {
    const mesh=node.getMesh();
    if (!mesh || !isVisible(node) || isCeiling(node) || classifyNode(node,config)!=='environment') continue;
    // Instanced transparent objects cannot be sorted independently. Preserve their existing batches.
    if (mesh.listPrimitives().some(p=>p.getMaterial()?.getAlphaMode()!=='OPAQUE' || p.getMaterial()?.getExtension('KHR_materials_transmission') || p.getMaterial()?.getExtension('KHR_materials_volume'))) continue;
    const matrix=node.getWorldMatrix();
    const t:vec3=[0,0,0],r:vec4=[0,0,0,1],scale:vec3=[1,1,1];
    MathUtils.decompose(matrix,t,r,scale);
    const composed=MathUtils.compose(t,r,scale,Array(16).fill(0) as mat4);
    // Three.js InstancedMesh does not support negative scales. TRS cannot encode shear.
    if (scale.some(value=>value<=0) || !MathUtils.eq(matrix,composed,1e-5)) continue;
    const group=groups.get(mesh)??[];group.push(node);groups.set(mesh,group);
  }
  return [...groups].flatMap(([mesh,nodes])=>{
    const vertices=mesh.listPrimitives().reduce((sum,p)=>sum+(p.getAttribute('POSITION')?.getCount()??0),0);
    return nodes.length>=config.instancing!.minInstances && vertices*(nodes.length-1)>=config.instancing!.minSavedVertices ? [{mesh,nodes,vertices}] : [];
  });
}
function createInstanceNodes(document: Document, batches: InstanceBatch[], transforms: {name:string;matrix:mat4}[][], parent: Node) {
  if (!batches.length) return {batches:0,instances:0,savedVertices:0,groups:[]};
  const extension=document.createExtension(EXTMeshGPUInstancing).setRequired(true);
  const buffer=document.getRoot().listBuffers()[0]??document.createBuffer();
  const report=[];
  for (let batchIndex=0;batchIndex<batches.length;batchIndex++) {
    const batch=batches[batchIndex], instances=transforms[batchIndex];
    const translation=document.createAccessor().setType('VEC3').setBuffer(buffer).setArray(new Float32Array(instances.length*3));
    const rotation=document.createAccessor().setType('VEC4').setBuffer(buffer).setArray(new Float32Array(instances.length*4));
    const scale=document.createAccessor().setType('VEC3').setBuffer(buffer).setArray(new Float32Array(instances.length*3));
    instances.forEach(({matrix},index)=>{
      const t:vec3=[0,0,0],r:vec4=[0,0,0,1],s:vec3=[1,1,1];
      MathUtils.decompose(matrix,t,r,s);
      translation.setElement(index,t);rotation.setElement(index,r);scale.setElement(index,s);
    });
    const attributes=extension.createInstancedMesh().setAttribute('TRANSLATION',translation).setAttribute('ROTATION',rotation).setAttribute('SCALE',scale);
    const node=document.createNode(`instances-${instances[0].name}`).setMesh(batch.mesh).setExtension('EXT_mesh_gpu_instancing',attributes)
      .setExtras({optimizerPass:'environment',sourceNames:instances.map(instance=>instance.name)});
    parent.addChild(node);
    report.push({name:instances[0].name,instances:instances.length,vertices:batch.vertices,savedVertices:batch.vertices*(instances.length-1)});
  }
  return {batches:report.length,instances:report.reduce((sum,batch)=>sum+batch.instances,0),savedVertices:report.reduce((sum,batch)=>sum+batch.savedVertices,0),groups:report};
}

/** Associates extension-owned texture slots as well as core material slots. */
export function textureBindings(material: Material): {texture: Texture; info: TextureInfo; slot: string}[] {
  const results: {texture:Texture;info:TextureInfo;slot:string}[] = [];
  const visited = new Set<object>();
  function visit(property: Material | import('@gltf-transform/core').ExtensionProperty) {
    if (visited.has(property)) return;
    visited.add(property);
    const edges = property.getGraph().listChildEdges(property);
    for (const edge of edges) {
      const child = edge.getChild();
      if (child instanceof Texture) {
        const info = edges.find(candidate => candidate.getName() === edge.getName()+'Info')?.getChild();
        if (info instanceof TextureInfo) results.push({texture:child,info,slot:edge.getName()});
      }
    }
    for (const edge of edges) { const child = edge.getChild(); if (child instanceof ExtensionProperty) visit(child); }
  }
  visit(material);
  return results;
}
