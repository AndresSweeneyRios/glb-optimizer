import { Logger, NodeIO } from '@gltf-transform/core';
import { OptimizerAtlasExtension } from './atlas-extension.ts';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

export async function createIO(): Promise<NodeIO> {
  // Draco's upstream package has no TypeScript declarations.
  // @ts-expect-error Untyped upstream binding.
  const { default: draco } = await import('draco3dgltf');
  await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready]);
  return new NodeIO().setLogger(new Logger(Logger.Verbosity.WARN)).registerExtensions([...ALL_EXTENSIONS,OptimizerAtlasExtension]).registerDependencies({
    'draco3d.decoder': await draco.createDecoderModule(),
    'draco3d.encoder': await draco.createEncoderModule(),
    'meshopt.decoder': MeshoptDecoder,
    'meshopt.encoder': MeshoptEncoder,
  });
}
