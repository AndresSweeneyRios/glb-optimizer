export async function probeGPU() {
  const { create, globals } = await import('webgpu');
  Object.assign(globalThis, globals);
  const gpu = create([]);
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter available. Install a compatible GPU driver.');
  const device = await adapter.requestDevice();
  try {
    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: `
        @group(0) @binding(0) var<storage, read_write> result: array<u32>;
        @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
          if (id.x < 256u) { result[id.x] = id.x * id.x; }
        }` }), entryPoint: 'main' },
    });
    const output = device.createBuffer({ size: 1024, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const staging = device.createBuffer({ size: 1024, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    try {
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: output } }] }));
      pass.dispatchWorkgroups(4);
      pass.end();
      encoder.copyBufferToBuffer(output, 0, staging, 0, 1024);
      device.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const result = new Uint32Array(staging.getMappedRange());
      for (let i = 0; i < 256; i++) if (result[i] !== i * i) throw new Error('GPU compute verification failed.');
      staging.unmap();
      return { vendor: adapter.info.vendor, device: adapter.info.device, description: adapter.info.description, fallback: adapter.info.isFallbackAdapter, verified: true };
    } finally { output.destroy(); staging.destroy(); }
  } finally { device.destroy(); }
}
