import * as THREE from 'three';

export const ATLAS_EXTENSION='EXT_glb_optimizer_atlas';
const declarations=`
flat varying vec4 vAtlasRect;
flat varying vec2 vAtlasWrap;
varying vec2 vAtlasLocalUv;
uniform vec2 uAtlasSize;
uniform float uAtlasMaxMip;
uniform sampler2D uAtlasColor;
uniform sampler2D uAtlasNormal;
uniform sampler2D uAtlasMSAO;
uniform sampler2D uAtlasProperties;
uniform sampler2D uAtlasEmissive;
uniform sampler2D uAtlasSpecular;
float atlasWrap(float uv,float mode){
  if(mode<0.5)return fract(uv);
  if(mode<1.5)return 1.0-abs(mod(uv,2.0)-1.0);
  return clamp(uv,0.0,1.0);
}
vec4 atlasSample(sampler2D image){
  vec2 local=vec2(atlasWrap(vAtlasLocalUv.x,vAtlasWrap.x),atlasWrap(vAtlasLocalUv.y,vAtlasWrap.y));
  vec2 sampleUv=vAtlasRect.xy+(vec2(0.5)+local*(vAtlasRect.zw*uAtlasSize-vec2(1.0)))/uAtlasSize;
  // Compute derivatives before wrapping; cap the footprint to the region's safe mip range.
  vec2 dx=dFdx(vAtlasLocalUv)*vAtlasRect.zw,dy=dFdy(vAtlasLocalUv)*vAtlasRect.zw;
  float footprint=max(length(dx*uAtlasSize),length(dy*uAtlasSize));
  float limit=min(1.0,exp2(uAtlasMaxMip)/max(footprint,1e-8));
  return textureGrad(image,sampleUv,dx*limit,dy*limit);
}
`;

function configure(material,metadata,transmissive) {
  const result=material.clone();
  // One logical atlas material can require opaque/transmission raster variants.
  // Keeping opaque surfaces in the opaque queue preserves the refraction background.
  result.transmission=transmissive?1:0;
  result.side=THREE.DoubleSide;
  result.forceSinglePass=true;
  result.userData.optimizerAtlas=metadata;
  result.onBeforeCompile=shader=>{
    Object.assign(shader.uniforms,{
      uAtlasSize:{value:new THREE.Vector2(metadata.width,metadata.height)},uAtlasMaxMip:{value:metadata.maxMip},
      uAtlasColor:{value:result.map},uAtlasNormal:{value:result.normalMap},uAtlasMSAO:{value:result.roughnessMap},
      uAtlasProperties:{value:result.transmissionMap},uAtlasEmissive:{value:result.emissiveMap},uAtlasSpecular:{value:result.specularColorMap},
    });
    shader.vertexShader=`attribute vec4 _atlas_rect;\nattribute vec2 _atlas_wrap;\nflat varying vec4 vAtlasRect;\nflat varying vec2 vAtlasWrap;\nvarying vec2 vAtlasLocalUv;\n`+shader.vertexShader;
    shader.vertexShader=shader.vertexShader.replace('#include <uv_vertex>',`#include <uv_vertex>\nvAtlasRect=_atlas_rect;vAtlasWrap=_atlas_wrap;vAtlasLocalUv=uv;`);
    shader.fragmentShader=declarations+shader.fragmentShader;
    shader.fragmentShader=shader.fragmentShader.replace('vec4 diffuseColor = vec4( diffuse, opacity );',`vec4 diffuseColor=vec4(diffuse,opacity);\nvec4 atlasPacked=atlasSample(uAtlasMSAO);\nvec4 atlasOptical=atlasSample(uAtlasProperties);\nfloat atlasFlags=floor(atlasOptical.b*3.0+0.5);\nif(!gl_FrontFacing&&floor(atlasFlags/2.0)<0.5)discard;`)
      .replace('#include <map_fragment>','diffuseColor *= atlasSample(uAtlasColor);')
      .replace('#include <alphatest_fragment>','if(diffuseColor.a<atlasOptical.a)discard;')
      .replace('#include <roughnessmap_fragment>','float roughnessFactor=atlasPacked.a;')
      .replace('#include <metalnessmap_fragment>','float metalnessFactor=atlasPacked.r;')
      .replace('#include <normal_fragment_maps>',`if(mod(atlasFlags,2.0)>0.5){vec3 mapN=atlasSample(uAtlasNormal).xyz*2.0-1.0;normal=normalize(tbn*mapN);}`)
      .replace('#include <emissivemap_fragment>',result.emissiveMap?'totalEmissiveRadiance *= atlasSample(uAtlasEmissive).rgb;':'')
      .replace('#include <lights_physical_fragment>',THREE.ShaderChunk.lights_physical_fragment
        .replace('material.ior = ior;','material.ior = 1.0+2.0*atlasOptical.g;')
        .replace('texture2D( specularIntensityMap, vSpecularIntensityMapUv ).a','atlasPacked.g')
        .replace('texture2D( specularColorMap, vSpecularColorMapUv ).rgb','atlasSample(uAtlasSpecular).rgb'))
      .replace('#include <aomap_fragment>',THREE.ShaderChunk.aomap_fragment.replace('texture2D( aoMap, vAoMapUv ).r','atlasPacked.b'))
      .replace('#include <transmission_fragment>',THREE.ShaderChunk.transmission_fragment.replace('texture2D( transmissionMap, vTransmissionMapUv ).r','atlasOptical.r'));
  };
  result.customProgramCacheKey=()=>`optimizer-atlas-v1:${Number(transmissive)}`;
  return result;
}

/** GLTFLoader plugin. Must be registered before loading an atlas GLB. WebGL2 adapter. */
export function optimizerAtlasPlugin(parser) {
  return {
    name:ATLAS_EXTENSION,
    async afterRoot(gltf) {
      const variants=new Map();
      const materials=await parser.getDependencies('material');
      const metadata=new Map();
      for(let i=0;i<materials.length;i++) {
        const definition=parser.json.materials[i]?.extensions?.[ATLAS_EXTENSION];
        if(definition) {
          if(definition.version!==1)throw new Error(`Unsupported atlas contract version ${definition.version}`);
          metadata.set(materials[i],definition);
        }
      }
      gltf.scene.traverse(object=>{
        if(!object.isMesh)return;
        const extras=object.geometry.userData;
        Object.assign(object.userData,extras);
        const original=object.material;
        const materialIndex=parser.associations.get(original)?.materials;
        const info=metadata.get(original)??parser.json.materials[materialIndex]?.extensions?.[ATLAS_EXTENSION];
        if(!info)return;
        if(!object.geometry.getAttribute('_atlas_rect')||!object.geometry.getAttribute('_atlas_wrap'))throw new Error('Atlas geometry is missing required attributes.');
        const transmissive=!!extras.optimizerTransmission;
        const key=materialIndex??original;
        let cached=variants.get(key);
        if(!cached){cached=new Map();variants.set(key,cached);}
        if(!cached.has(transmissive))cached.set(transmissive,configure(original,info,transmissive));
        object.material=cached.get(transmissive);
      });
      gltf.userData.optimizerAtlas={logicalMaterials:metadata.size,rasterVariants:[...variants.values()].reduce((sum,map)=>sum+map.size,0)};
    },
  };
}
