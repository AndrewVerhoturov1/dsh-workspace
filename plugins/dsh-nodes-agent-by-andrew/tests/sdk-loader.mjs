import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const installed = process.env.DSH_ROOT || join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh');
const sdk = createRequire(join(installed, 'package.json'));
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'dsh-ptc/json') return { url: new URL('../../dsh-ptc/src/json.js', import.meta.url).href, shortCircuit: true };
  if (specifier === 'dsh-ptc') return { url: new URL('../../dsh-ptc/src/index.js', import.meta.url).href, shortCircuit: true };
  try { return next(specifier, context); } catch (error) {
    if (!specifier.startsWith('@deepseek-ai/') && specifier !== 'zod' && specifier !== 'quickjs-emscripten') throw error;
    const base = specifier === 'quickjs-emscripten' ? createRequire(join(process.env.USERPROFILE,'.dsh/plugins/dsh-ptc/package.json')) : sdk;
    return { url: pathToFileURL(base.resolve(specifier)).href, shortCircuit: true };
  }
}});
