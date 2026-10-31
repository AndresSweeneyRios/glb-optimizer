import sharp from 'sharp';
import {type Document, type Material, type Texture, type TextureInfo} from '@gltf-transform/core';
import {KHRMaterialsSpecular, KHRMaterialsTransmission, KHRMaterialsEmissiveStrength, type Specular, type Transmission, type IOR, type EmissiveStrength, type Transform} from '@gltf-transform/extensions';
import {packAtlas,type AtlasRegion} from './atlas.ts';
import {createAtlasGPU} from './atlas-gpu.ts';
import {OptimizerAtlasExtension,ATLAS_EXTENSION} from './atlas-extension.ts';
import {planTextureSizes} from './texel-density.ts';
import {textureBindings,type StaticSceneConfig,prepareStaticScene} from './static-scene.ts';
import {transformMesh} from '@gltf-transform/functions';

type Prepared=ReturnType<typeof prepareStaticScene>;
interface UVLayout {texCoord:number;scale:number[];offset:number[];rotation:number;wrapS:number;wrapT:number}
interface Descriptor {material:Material;region:AtlasRegion;uv:UVLayout;transmission:boolean}
const slotNames=['baseColorTexture','normalTexture','metallicRoughnessTexture','occlusionTexture','specularTexture','emissiveTexture','specularColorTexture','transmissionTexture'];
function uvLayout(info?:TextureInfo): UVLayout {
  const transform=info?.getExtension<Transform>('KHR_texture_transform');
  return {texCoord:transform?.getTexCoord()??info?.getTexCoord()??0,scale:transform?.getScale()??[1,1],offset:transform?.getOffset()??[0,0],rotation:transform?.getRotation()??0,wrapS:info?.getWrapS()??10497,wrapT:info?.getWrapT()??10497};
}
function wrapMode(value:number){if(value===10497)return 0;if(value===33648)return 1;if(value===33071)return 2;throw new Error(`Unsupported wrap mode: ${value}`);}
function configureGeometry(primitive:import('@gltf-transform/core').Primitive,descriptor:Descriptor,output:Material,width:number,height:number,document:Document) {
  const count=primitive.getAttribute('POSITION')!.getCount();
  const source=primitive.getAttribute(`TEXCOORD_${descriptor.uv.texCoord}`);
  const uv=new Float32Array(count*2),rect=new Float32Array(count*4),wrap=new Float32Array(count*2);
  const {region,uv:layout}=descriptor;
  const c=Math.cos(layout.rotation),s=Math.sin(layout.rotation);
  for(let i=0;i<count;i++) {
    const point=source?.getElement(i,[])??[0.5,0.5];
    uv.set([layout.offset[0]+c*point[0]*layout.scale[0]-s*point[1]*layout.scale[1],layout.offset[1]+s*point[0]*layout.scale[0]+c*point[1]*layout.scale[1]],i*2);
    rect.set([region.x/width,region.y/height,region.width/width,region.height/height],i*4);
    wrap.set([wrapMode(layout.wrapS),wrapMode(layout.wrapT)],i*2);
  }
  // All merged streams share one layout. Source tangents are regenerated in the shader
  // from the unwrapped, transformed UV set used to sample the normal map.
  for(const semantic of primitive.listSemantics())if(!['POSITION','NORMAL'].includes(semantic))primitive.setAttribute(semantic,null);
  const buffer=primitive.getAttribute('POSITION')!.getBuffer();
  primitive.setAttribute('TEXCOORD_0',document.createAccessor().setType('VEC2').setArray(uv).setBuffer(buffer));
  primitive.setAttribute('_ATLAS_RECT',document.createAccessor().setType('VEC4').setArray(rect).setBuffer(buffer));
  primitive.setAttribute('_ATLAS_WRAP',document.createAccessor().setType('VEC2').setArray(wrap).setBuffer(buffer));
  if(!primitive.getAttribute('NORMAL')) throw new Error('Atlas merging requires vertex normals.');
  primitive.setMaterial(output);
}

export async function bakeMaterialAtlases(document:Document,prepared:Prepared,config:StaticSceneConfig) {
  const options=config.atlas!;
  const dimensions=new Map<Texture,{width:number;height:number}>();
  for(const texture of document.getRoot().listTextures()) {
    if(texture.getMimeType()==='image/ktx2')throw new Error('Atlas baking requires original PNG/JPEG textures.');
    const metadata=await sharp(texture.getImage()!).metadata();
    if(!metadata.width||!metadata.height)throw new Error('Missing source image dimensions.');
    dimensions.set(texture,{width:metadata.width,height:metadata.height});
  }
  const sizes=planTextureSizes(prepared.primitives,dimensions,prepared.cameraBounds,config);
  const materials=[...new Set(prepared.primitives.map(item=>item.primitive.getMaterial()))];
  if(materials.includes(null))throw new Error('Assign a material to every primitive before atlas baking.');
  const sources=materials as Material[];
  const bindings=sources.map(material=>textureBindings(material));
  const layouts=bindings.map((maps,index)=>{
    const layout=uvLayout(maps[0]?.info);
    if(maps.some(map=>JSON.stringify(uvLayout(map.info))!==JSON.stringify(layout)))throw new Error(`Material ${sources[index].getName()} uses independent texture UV transforms. Separate-coordinate atlas baking is not supported yet.`);
    return layout;
  });
  for(const material of sources) {
    if(material.getAlphaMode()==='BLEND')throw new Error(`Alpha blending needs a separate render-state partition: ${material.getName()}`);
    const supported=['KHR_materials_specular','KHR_materials_ior','KHR_materials_transmission','KHR_materials_emissive_strength'];
    for(const extension of material.listExtensions())if(!supported.includes(extension.extensionName))throw new Error(`Unsupported atlas material extension ${extension.extensionName}: ${material.getName()}`);
    const ior=material.getExtension<IOR>('KHR_materials_ior')?.getIOR()??1.5;
    if(ior<1||ior>3)throw new Error(`IOR outside the optical atlas range 1–3: ${material.getName()}`);
    if(material.getExtension<Specular>('KHR_materials_specular')?.getSpecularColorFactor().some(value=>value<0||value>1))throw new Error('Specular color factors must be in [0,1].');
  }
  const tiles=sources.map((_,index)=>{
    const maps=bindings[index];
    const width=Math.max(16,...maps.map(map=>sizes.get(map.texture)!.width));
    const height=Math.max(16,...maps.map(map=>sizes.get(map.texture)!.height));
    return {id:String(index),width:Math.ceil(width/16)*16,height:Math.ceil(height/16)*16};
  });
  const packed=packAtlas(tiles,{padding:options.padding,maxSize:options.maxSize});
  const layout={...packed,width:Math.ceil(packed.width/16)*16,height:Math.ceil(packed.height/16)*16};
  const emission=sources.map(material=>material.getEmissiveFactor().map(value=>value*(material.getExtension<EmissiveStrength>('KHR_materials_emissive_strength')?.getEmissiveStrength()??1)));
  const emissiveScale=Math.max(1,...emission.flat());
  const optional={emissive:emission.some(values=>values.some(value=>value>0)),specular:sources.some((material,index)=>bindings[index].some(map=>map.slot==='specularColorTexture')||(material.getExtension<Specular>('KHR_materials_specular')?.getSpecularColorFactor()??[1,1,1]).some(value=>value!==1))};
  const gpu=await createAtlasGPU(layout,optional);
  const descriptors=new Map<Material,Descriptor>();
  const decoded=new Map<string,Promise<Uint8Array>>();
  try {
    for(let index=0;index<sources.length;index++) {
      const material=sources[index],region=layout.regions.find(region=>region.id===String(index))!;
      const maps=bindings[index];
      const images=await Promise.all(slotNames.map(async slot=>{
        const map=maps.find(map=>map.slot===slot);if(!map)return null;
        const key=`${document.getRoot().listTextures().indexOf(map.texture)}:${region.width}:${region.height}:${['baseColorTexture','emissiveTexture','specularColorTexture'].includes(slot)}`;
        if(!decoded.has(key))decoded.set(key,(async()=>{
          let image=sharp(map.texture.getImage()!);
          if(['baseColorTexture','emissiveTexture','specularColorTexture'].includes(slot))image=image.gamma();
          return new Uint8Array(await image.resize(region.width,region.height,{fit:'fill',kernel:'lanczos3'}).ensureAlpha().raw().toBuffer());
        })());
        return decoded.get(key)!;
      }));
      const specular=material.getExtension<Specular>('KHR_materials_specular');
      const transmission=material.getExtension<Transmission>('KHR_materials_transmission');
      const ior=material.getExtension<IOR>('KHR_materials_ior')?.getIOR()??1.5;
      const hasNormal=maps.some(map=>map.slot==='normalTexture');
      await gpu.bake({region,images,base:material.getBaseColorFactor(),msao:[material.getMetallicFactor(),specular?.getSpecularFactor()??1,material.getOcclusionStrength(),material.getRoughnessFactor()],
        optics:[transmission?.getTransmissionFactor()??0,(ior-1)/2,(Number(hasNormal)+2*Number(material.getDoubleSided()))/3,material.getAlphaMode()==='MASK'?material.getAlphaCutoff():0],
        emissive:emission[index].map(value=>value/emissiveScale),specularColor:specular?.getSpecularColorFactor()??[1,1,1],normalScale:material.getNormalScale(),opaque:material.getAlphaMode()==='OPAQUE'});
      descriptors.set(material,{material,region,uv:layouts[index],transmission:(transmission?.getTransmissionFactor()??0)>0});
    }
    const pixels=await gpu.read();
    const roles=['color','normal','msao','optics','emissive','specular'];
    const atlases:(Texture|null)[]=[];
    for(let index=0;index<pixels.length;index++) {
      const data=pixels[index];if(!data){atlases.push(null);continue;}
      const png=await sharp(data,{raw:{width:layout.width,height:layout.height,channels:4}}).png().toBuffer();
      atlases.push(document.createTexture(`atlas-${roles[index]}`).setImage(png).setMimeType('image/png').setExtras({optimizerAtlas:true,optimizerAtlasRole:roles[index]}));
    }
    const extension=document.createExtension(OptimizerAtlasExtension).setRequired(true);
    const spec=document.createExtension(KHRMaterialsSpecular),trans=document.createExtension(KHRMaterialsTransmission);
    const output=new Map<string,Material>();
    for(const group of ['environment','table','ceiling']) {
      const members=prepared.primitives.filter(item=>(item.ceiling?'ceiling':item.pass)===group);
      if(!members.length)continue;
      const hasTransmission=members.some(item=>descriptors.get(item.primitive.getMaterial()!)!.transmission);
      const material=document.createMaterial(group).setDoubleSided(true).setBaseColorFactor([1,1,1,1]).setRoughnessFactor(1).setMetallicFactor(1)
        .setBaseColorTexture(atlases[0]).setNormalTexture(atlases[1]).setMetallicRoughnessTexture(atlases[2]).setOcclusionTexture(atlases[2]);
      material.setExtension('KHR_materials_specular',spec.createSpecular().setSpecularFactor(1).setSpecularTexture(atlases[2]).setSpecularColorTexture(atlases[5]));
      material.setExtension('KHR_materials_transmission',trans.createTransmission().setTransmissionFactor(hasTransmission?1:0).setTransmissionTexture(atlases[3]));
      if(atlases[4]) {
        material.setEmissiveFactor([1,1,1]).setEmissiveTexture(atlases[4]);
        if(emissiveScale>1)material.setExtension('KHR_materials_emissive_strength',document.createExtension(KHRMaterialsEmissiveStrength).createEmissiveStrength().setEmissiveStrength(emissiveScale));
      }
      for(const {info}of textureBindings(material))info.setWrapS(33071).setWrapT(33071).setMagFilter(9729).setMinFilter(9987);
      material.setExtension(ATLAS_EXTENSION,extension.createAtlas().setMetadata({version:1,width:layout.width,height:layout.height,padding:options.padding,maxMip:Math.max(0,Math.floor(Math.log2(options.padding))-2),emissiveScale}));
      output.set(group,material);
    }
    for(const item of prepared.primitives) {
      const descriptor=descriptors.get(item.primitive.getMaterial()!)!;
      item.transmission=descriptor.transmission;
      configureGeometry(item.primitive,descriptor,output.get(item.ceiling?'ceiling':item.pass)!,layout.width,layout.height,document);
    }
    for(const batch of prepared.instances) {
      const mesh=batch.mesh.clone();
      transformMesh(mesh,[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
      for(const primitive of mesh.listPrimitives())configureGeometry(primitive,descriptors.get(primitive.getMaterial()!)!,output.get('environment')!,layout.width,layout.height,document);
      batch.mesh=mesh;
    }
    return {backend:'WebGPU',adapter:gpu.adapter,materials:output.size,regions:layout.regions.length,size:[layout.width,layout.height],padding:options.padding,maxMip:Math.max(0,Math.floor(Math.log2(options.padding))-2),channels:roles.filter((_,index)=>pixels[index]),sourceTextures:dimensions.size};
  } finally {gpu.destroy();}
}
