#!/usr/bin/env node
import { inspect, optimize } from './optimizer.ts';
import { probeGPU } from './gpu.ts';
import {readStaticConfig} from './config.ts';

const [command, input, output, ...extra] = process.argv.slice(2);
try {
  if (extra.length && !(command === 'optimize' && extra.length === 2 && extra[0] === '--config')) throw new Error('Unexpected arguments.');
  if (command === 'inspect' && input && !output) console.log(JSON.stringify(await inspect(input), null, 2));
  else if (command === 'optimize' && input && output) console.log(JSON.stringify(await optimize(input, output, extra[1] ? await readStaticConfig(extra[1]) : undefined), null, 2));
  else if (command === 'gpu' && !input) console.log(JSON.stringify(await probeGPU(), null, 2));
  else {
    console.log('Usage:\n  npm run cli -- inspect input.glb\n  npm run cli -- optimize input.glb output.glb [--config presets/pool.json]\n  npm run cli -- gpu');
    if (command && command !== '--help') process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
