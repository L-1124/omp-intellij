import type {
  CommandDefinition,
  ExtensionContext,
  ExtensionPluginInstance,
  SelectItem,
  ToolDefinition,
  ZodArrayLike,
  ZodBooleanLike,
  ZodEnumLike,
  ZodLike,
  ZodNumberLike,
  ZodObjectLike,
  ZodRecordLike,
  ZodStringLike,
} from '../src/extension-types.js';

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
  confirm?(message: string): Promise<boolean>;
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
  registerTool<TParams = unknown, TDetails = Record<string, unknown>>(
    tool: ToolDefinition<TParams, TDetails>,
  ): void;
  getTool(name: string): ToolDefinition | undefined;
  on: NonNullable<ExtensionPluginInstance['on']>;
  emit(event: string, ...args: unknown[]): void;
}

export function createMockZod(): ZodLike {
  const schemaBase = {
    describe() {
      return this;
    },
    optional() {
      return this;
    },
    default() {
      return this;
    },
  };

  const stringSchema: ZodStringLike = {
    ...schemaBase,
    describe() {
      return this;
    },
    optional() {
      return this;
    },
  };

  const numberSchema: ZodNumberLike = {
    ...schemaBase,
    int() {
      return this;
    },
    min() {
      return this;
    },
    max() {
      return this;
    },
    default() {
      return this;
    },
    describe() {
      return this;
    },
    optional() {
      return this;
    },
  };

  const booleanSchema: ZodBooleanLike = {
    ...schemaBase,
    default() {
      return this;
    },
    describe() {
      return this;
    },
    optional() {
      return this;
    },
  };

  const arraySchema: ZodArrayLike = {
    ...schemaBase,
    optional() {
      return this;
    },
    describe() {
      return this;
    },
  };

  const recordSchema: ZodRecordLike = {
    ...schemaBase,
    optional() {
      return this;
    },
    describe() {
      return this;
    },
  };

  const enumSchema: ZodEnumLike = {
    ...schemaBase,
    default() {
      return this;
    },
    describe() {
      return this;
    },
    optional() {
      return this;
    },
  };

  const objectSchema: ZodObjectLike = {
    ...schemaBase,
    describe() {
      return this;
    },
  };

  return {
    object(_shape: Record<string, unknown>): ZodObjectLike {
      return { ...objectSchema };
    },
    string(): ZodStringLike {
      return { ...stringSchema };
    },
    number(): ZodNumberLike {
      return { ...numberSchema };
    },
    boolean(): ZodBooleanLike {
      return { ...booleanSchema };
    },
    array(_inner: unknown): ZodArrayLike {
      return { ...arraySchema };
    },
    record(_keyOrVal: unknown, _val?: unknown): ZodRecordLike {
      return { ...recordSchema };
    },
    enum(_values: readonly string[] | string[]): ZodEnumLike {
      return { ...enumSchema };
    },
  };
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
    registerTool<TParams = unknown, TDetails = Record<string, unknown>>(
      tool: ToolDefinition<TParams, TDetails>,
    ) {
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
    zod: createMockZod(),
  };
}

export interface CreateMockCtxOptions {
  agent?: { kind: string; [key: string]: unknown };
  theme?: unknown;
  select?: (prompt: string, items: SelectItem[]) => Promise<SelectItem | string | undefined | null>;
  confirm?: (message: string) => Promise<boolean>;
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
