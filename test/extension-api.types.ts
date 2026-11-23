import type { ExtensionAPI, ExtensionFactory } from '@oh-my-pi/pi-coding-agent';
import extension from '../src/extension/extension.js';
import type { ExtensionPluginInstance } from '../src/shared/extension-types.js';

type CompatibleHost<T extends ExtensionPluginInstance> = T;
export type OfficialExtensionHost = CompatibleHost<ExtensionAPI>;

export const officialExtensionFactory: ExtensionFactory = extension;
