import * as zod from '@oh-my-pi/omptype/zod';
import type {
  CommandDefinition,
  ExtensionContext,
  ExtensionPluginInstance,
  ExtensionSessionEvents,
  ExtensionSessionHandler,
  ExtensionUI,
  ToolDefinition,
} from '../src/shared/extension-types.js';

export interface MockNotification {
  msg: string;
  level: string;
}

export interface MockStatusCall {
  key: string;
  value: string | undefined;
}

export interface MockUI extends ExtensionUI {
  setStatus: NonNullable<ExtensionUI['setStatus']>;
}

export interface MockContext extends ExtensionContext {
  cwd: string;
  agent: { kind: string };
  ui: MockUI;
  statusCalls: MockStatusCall[];
  notifications: MockNotification[];
}

export interface MockPi extends ExtensionPluginInstance {
  setLabel(l: string): void;
  getLabel(): string;
  registerCommand(name: string, def: CommandDefinition): void;
  getCommand(name: string): CommandDefinition | undefined;
  getTool(name: string): ToolDefinition | undefined;
  on: NonNullable<ExtensionPluginInstance['on']>;
  emit<K extends keyof ExtensionSessionEvents>(
    event: K,
    payload: ExtensionSessionEvents[K],
    ctx: ExtensionContext,
  ): Promise<void>;
}

export function createMockPi(): MockPi {
  const commands = new Map<string, CommandDefinition>();
  const listeners: { [K in keyof ExtensionSessionEvents]: ExtensionSessionHandler<K>[] } = {
    session_start: [],
    session_switch: [],
    session_shutdown: [],
  };
  const tools = new Map<string, ToolDefinition>();
  let label = '';

  return {
    setLabel(l: string) {
      label = l;
    },
    getLabel() {
      return label;
    },
    registerCommand(name: string, def: CommandDefinition) {
      commands.set(name, def);
    },
    getCommand(name: string) {
      return commands.get(name);
    },
    registerTool(tool) {
      tools.set(tool.name, tool as unknown as ToolDefinition);
    },
    getTool(name: string) {
      return tools.get(name);
    },
    on<K extends keyof ExtensionSessionEvents>(event: K, handler: ExtensionSessionHandler<K>) {
      listeners[event].push(handler);
    },
    async emit<K extends keyof ExtensionSessionEvents>(
      event: K,
      payload: ExtensionSessionEvents[K],
      ctx: ExtensionContext,
    ) {
      for (const handler of listeners[event]) {
        await handler(payload, ctx);
      }
    },
    zod,
  };
}

export interface CreateMockCtxOptions {
  agent?: { kind: string; [key: string]: unknown };
  select?: ExtensionUI['select'];
  confirm?: ExtensionUI['confirm'];
}

export function createMockCtx(cwd: string, options: CreateMockCtxOptions = {}): MockContext {
  const statusCalls: MockStatusCall[] = [];
  const notifications: MockNotification[] = [];

  const ui: MockUI = {
    setStatus(key, value) {
      statusCalls.push({ key, value });
    },
    notify(msg, level = 'info') {
      notifications.push({ msg, level });
    },
  };

  if (options.select) {
    ui.select = options.select;
  }
  if (options.confirm) {
    ui.confirm = options.confirm;
  }

  return {
    cwd,
    agent: options.agent || { kind: 'main' },
    ui,
    statusCalls,
    notifications,
  };
}
