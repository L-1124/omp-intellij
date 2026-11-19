import * as zod from '@oh-my-pi/omptype/zod';
import type {
  CommandDefinition,
  ExtensionContext,
  ExtensionPluginInstance,
  SelectItem,
  ToolDefinition,
} from '../src/shared/extension-types.js';

export interface MockNotification {
  msg: string;
  level: string;
}

export interface MockStatusCall {
  key: string;
  value: string;
}

export interface MockUI {
  setStatus(key: string, value: string): void;
  notify(msg: string, level?: string): void;
  confirm?(title: string, message: string): Promise<boolean>;
  select?(prompt: string, items: SelectItem[]): Promise<SelectItem | string | undefined | null>;
  theme?: unknown;
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
  on(event: string, handler: (...args: never[]) => void): void;
  emit(event: string, ...args: unknown[]): void;
}

export function createMockPi(): MockPi {
  const commands = new Map<string, CommandDefinition>();
  const listeners = new Map<string, Array<(...args: never[]) => void>>();
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
    on(event: string, handler: (...args: never[]) => void) {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
    },
    emit(event: string, ...args: unknown[]) {
      const handlers = listeners.get(event) || [];
      for (const h of handlers) {
        Reflect.apply(h, undefined, args);
      }
    },
    zod,
  };
}

export interface CreateMockCtxOptions {
  agent?: { kind: string; [key: string]: unknown };
  theme?: unknown;
  select?: (prompt: string, items: SelectItem[]) => Promise<SelectItem | string | undefined | null>;
  confirm?: (title: string, message: string) => Promise<boolean>;
}

export function createMockCtx(cwd: string, options: CreateMockCtxOptions = {}): MockContext {
  const statusCalls: MockStatusCall[] = [];
  const notifications: MockNotification[] = [];

  const ui: MockUI = {
    setStatus(key: string, value: string) {
      statusCalls.push({ key, value });
    },
    notify(msg: string, level: string = 'info') {
      notifications.push({ msg, level });
    },
    theme: options.theme,
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
