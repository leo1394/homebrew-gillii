import { miniProgramProvider } from './miniprogram/index.mjs';
import { apkProvider } from './apk/index.mjs';
import { workbenchProvider } from './workbench/index.mjs';

// Preserve CLI routing; new input types can register their own provider here.
export function providerFor(command, options) {
  if (command === 'open') return workbenchProvider;
  return command === 'chase' && !options.appid && options.input ? apkProvider : miniProgramProvider;
}
