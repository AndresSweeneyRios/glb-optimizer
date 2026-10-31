import { Extension, ExtensionProperty, PropertyType, type IProperty, type Nullable, type ReaderContext, type WriterContext } from '@gltf-transform/core';

export const ATLAS_EXTENSION = 'EXT_glb_optimizer_atlas';
export interface AtlasMetadata extends Record<string,unknown> { version: 1; flagsScale?: number; width: number; height: number; padding: number; maxMip: number; emissiveScale: number }
interface IAtlas extends IProperty { metadata: AtlasMetadata }
export class AtlasMaterial extends ExtensionProperty<IAtlas> {
  static EXTENSION_NAME = ATLAS_EXTENSION;
  declare extensionName: typeof ATLAS_EXTENSION;
  declare propertyType: 'OptimizerAtlasMaterial';
  declare parentTypes: [PropertyType.MATERIAL];
  protected init() { this.extensionName=ATLAS_EXTENSION;this.propertyType='OptimizerAtlasMaterial';this.parentTypes=[PropertyType.MATERIAL]; }
  protected getDefaults(): Nullable<IAtlas> { return {...super.getDefaults(),metadata:{version:1,width:1,height:1,padding:16,maxMip:0,emissiveScale:1}}; }
  getMetadata(): AtlasMetadata {return this.get('metadata');}
  setMetadata(metadata: AtlasMetadata): this {return this.set('metadata',metadata);}
}
/** Required renderer contract: ordinary glTF shaders cannot wrap individual atlas regions. */
export class OptimizerAtlasExtension extends Extension {
  static EXTENSION_NAME=ATLAS_EXTENSION;
  readonly extensionName=ATLAS_EXTENSION;
  createAtlas() {return new AtlasMaterial(this.document.getGraph());}
  read(context: ReaderContext): this {
    for(const [index,definition] of (context.jsonDoc.json.materials??[]).entries()) {
      const metadata=definition.extensions?.[ATLAS_EXTENSION] as AtlasMetadata|undefined;
      if(metadata) context.materials[index].setExtension(ATLAS_EXTENSION,this.createAtlas().setMetadata(metadata));
    }
    return this;
  }
  write(context: WriterContext): this {
    for(const material of this.document.getRoot().listMaterials()) {
      const atlas=material.getExtension<AtlasMaterial>(ATLAS_EXTENSION);
      if(!atlas)continue;
      const definition=context.jsonDoc.json.materials![context.materialIndexMap.get(material)!];
      definition.extensions??={};definition.extensions[ATLAS_EXTENSION]={...atlas.getMetadata()};
    }
    return this;
  }
}
