import{test}from'node:test';
import assert from'node:assert/strict';
import{createAtlasGPU}from'../src/atlas-gpu.ts';
import{mirroredCoordinate}from'../src/atlas.ts';

test('GPU atlas bake matches mirrored source pixels and PBR packing',async context=>{
  const region={id:'tile',width:16,height:16,x:16,y:16,padding:16};
  let gpu;
  try{gpu=await createAtlasGPU({width:48,height:48,regions:[region]},{emissive:true,specular:true});}
  catch(error){if(/requires a hardware/.test(String(error))){context.skip('No hardware GPU');return;}throw error;}
  try{
    const color=new Uint8Array(16*16*4),mr=new Uint8Array(color.length),ao=new Uint8Array(color.length),spec=new Uint8Array(color.length);
    for(let i=0;i<256;i++){color.set([i%16*16,Math.floor(i/16)*16,128,128],i*4);mr.set([255,128,64,255],i*4);ao.set([128,0,0,255],i*4);spec.set([0,0,0,128],i*4);}
    await gpu.bake({region,images:[color,null,mr,ao,spec,null,null,null],base:[1,1,1,.5],msao:[.5,.5,.5,.5],optics:[.25,.25,2/3,0],emissive:[.25,0,0],specularColor:[1,.5,1],normalScale:1,opaque:false});
    const output=await gpu.read();
    assert.ok(output.every(layer=>layer?.length===48*48*4));
    for(const [x,y] of [[0,0],[15,15],[16,16],[31,31],[32,32],[47,47]]){
      const source=(mirroredCoordinate(y-16,16)*16+mirroredCoordinate(x-16,16))*4;
      const dest=(y*48+x)*4;
      for(let channel=0;channel<3;channel++)assert.ok(Math.abs(output[0]![dest+channel]-color[source+channel])<=1);
      assert.equal(output[0]![dest+3],64);
      assert.deepEqual([...output[2]!.slice(dest,dest+4)],[32,64,192,64]);
      assert.deepEqual([...output[3]!.slice(dest,dest+4)],[64,64,170,0]);
      assert.ok(Math.abs(output[4]![dest]-137)<=1);
      assert.ok(Math.abs(output[5]![dest+1]-188)<=1);
    }
  }finally{gpu.destroy();}
});
