import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document } from '@gltf-transform/core';
import { createIO } from '../src/io.ts';
import { optimize, summarize } from '../src/optimizer.ts';
import { mirroredCoordinate, packAtlas } from '../src/atlas.ts';

test('mirrored bleed repeats the edge and handles padding larger than a tile', () => {
  assert.deepEqual(Array.from({ length: 12 }, (_, i) => mirroredCoordinate(i - 4, 3)), [2, 2, 1, 0, 0, 1, 2, 2, 1, 0, 0, 1]);
});
test('atlas packing is order independent and keeps padding disjoint', () => {
  const tiles = [{ id: 'wall', width: 32, height: 16 }, { id: 'floor', width: 16, height: 32 }];
  assert.deepEqual(packAtlas(tiles), packAtlas(tiles.toReversed()));
  assert.throws(() => packAtlas(tiles, { maxSize: 32 }));
  const layout = packAtlas(tiles);
  for (const region of layout.regions) {
    assert.ok(region.x >= 16 && region.y >= 16);
    assert.ok(region.x + region.width + 16 <= layout.width);
    assert.ok(region.y + region.height + 16 <= layout.height);
  }
});
test('optimization preserves hierarchy, skinning, morphs, animation and extras', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'glb-optimizer-'));
  try {
    const doc = new Document();
    const buffer = doc.createBuffer();
    const accessor = (data: Float32Array<ArrayBuffer>, type: 'VEC3' | 'VEC4' | 'SCALAR') => doc.createAccessor().setType(type).setArray(data).setBuffer(buffer);
    const position = accessor(new Float32Array([0,0,0, 1,0,0, 0,1,0]), 'VEC3');
    const primitive = doc.createPrimitive().setAttribute('POSITION', position).setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint16Array([2, 0, 1])).setBuffer(buffer));
    primitive.setAttribute('JOINTS_0', doc.createAccessor().setType('VEC4').setArray(new Uint16Array(12)).setBuffer(buffer));
    primitive.setAttribute('WEIGHTS_0', accessor(new Float32Array([1,0,0,0, 1,0,0,0, 1,0,0,0]), 'VEC4'));
    primitive.addTarget(doc.createPrimitiveTarget().setAttribute('POSITION', accessor(new Float32Array([0,0,1, 0,0,1, 0,0,1]), 'VEC3')));
    const joint = doc.createNode('joint');
    const meshNode = doc.createNode('mesh').setMesh(doc.createMesh('triangle').addPrimitive(primitive).setWeights([0.25])).setSkin(doc.createSkin().addJoint(joint)).setExtras({ authored: true });
    const parent = doc.createNode('parent').addChild(meshNode).addChild(joint);
    doc.createScene().addChild(parent);
    const sampler = doc.createAnimationSampler().setInput(accessor(new Float32Array([0,1]), 'SCALAR')).setOutput(accessor(new Float32Array([0,0,0, 1,0,0]), 'VEC3'));
    doc.createAnimation().addSampler(sampler).addChannel(doc.createAnimationChannel().setSampler(sampler).setTargetNode(meshNode).setTargetPath('translation'));
    const io = await createIO();
    const source = join(directory, 'source.glb'), output = join(directory, 'output.glb');
    await io.write(source, doc);
    await optimize(source, output);
    const result = await io.read(output);
    assert.equal(summarize(result).skins, 1);
    assert.equal(summarize(result).morphTargets, 1);
    assert.equal(summarize(result).animations, 1);
    const node = result.getRoot().listNodes().find(node => node.getName() === 'mesh')!;
    assert.deepEqual(node.getExtras(), { authored: true });
    assert.equal(node.getParentNode()?.getName(), 'parent');
    assert.deepEqual(node.getMesh()?.getWeights(), [0.25]);
    assert.equal(node.getMesh()?.listPrimitives()[0].getAttribute('WEIGHTS_0')?.getCount(), 3);
    await assert.rejects(optimize(source, source));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
