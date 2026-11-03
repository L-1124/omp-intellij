/**
 * Minimal accurate structural OMP extension API interfaces.
 */

export interface SelectItem {
  label: string;
  value: string;
  description?: string;
}

export interface ExtensionUI {
  setStatus?(key: string, text: string): void;
  notify(message: string, level?: 'info' | 'warning' | 'error'): void;
  confirm?(message: string): Promise<boolean>;
  select?(prompt: string, items: SelectItem[]): Promise<SelectItem | string | undefined | null>;
  theme?: unknown;
}

export interface ExtensionContext {
  cwd: string;
  agent?: {
    kind?: string;
    [key: string]: unknown;
  };
  ui?: ExtensionUI;
}

export interface CommandDefinition {
  description: string;
  handler(rawArgs: string, ctx: ExtensionContext): Promise<void> | void;
}

export interface ToolContentItem {
  type: string;
  text: string;
}

export interface ToolUpdate {
  content?: ToolContentItem[];
  details?: Record<string, unknown>;
}

export interface ToolResult<TDetails = Record<string, unknown>> {
  content: ToolContentItem[];
  details?: TDetails;
  isError: boolean;
}

export interface ToolDefinition<TParams = unknown, TDetails = Record<string, unknown>> {
  name: string;
  label?: string;
  description: string;
  approval?: 'read' | 'exec';
  parameters: unknown;
  execute(
    id: string,
    params: TParams,
    signal: AbortSignal | undefined,
    onUpdate: ((update: ToolUpdate) => void) | undefined,
    ctx: ExtensionContext,
  ): Promise<ToolResult<TDetails>>;
}

export interface ZodSchemaLike {
  describe?(desc: string): ZodSchemaLike;
  optional?(): ZodSchemaLike;
  default?(val: unknown): ZodSchemaLike;
}

export interface ZodStringLike extends ZodSchemaLike {
  optional(): ZodStringLike;
  describe(desc: string): ZodStringLike;
}

export interface ZodNumberLike extends ZodSchemaLike {
  int(): ZodNumberLike;
  min(n: number): ZodNumberLike;
  max(n: number): ZodNumberLike;
  default(n: number): ZodNumberLike;
  describe(desc: string): ZodNumberLike;
  optional(): ZodNumberLike;
}

export interface ZodBooleanLike extends ZodSchemaLike {
  default(b: boolean): ZodBooleanLike;
  describe(desc: string): ZodBooleanLike;
  optional(): ZodBooleanLike;
}

export interface ZodArrayLike extends ZodSchemaLike {
  optional(): ZodArrayLike;
  describe(desc: string): ZodArrayLike;
}

export interface ZodRecordLike extends ZodSchemaLike {
  optional(): ZodRecordLike;
  describe(desc: string): ZodRecordLike;
}

export interface ZodEnumLike extends ZodSchemaLike {
  default(val: string): ZodEnumLike;
  describe(desc: string): ZodEnumLike;
  optional(): ZodEnumLike;
}

export interface ZodObjectLike extends ZodSchemaLike {
  describe(desc: string): ZodObjectLike;
}

export interface ZodLike {
  object(shape: Record<string, unknown>): ZodObjectLike;
  string(): ZodStringLike;
  number(): ZodNumberLike;
  boolean(): ZodBooleanLike;
  array(inner: unknown): ZodArrayLike;
  record(keyOrVal: unknown, val?: unknown): ZodRecordLike;
  enum(values: readonly string[] | string[]): ZodEnumLike;
}

export interface ExtensionPluginInstance {
  setLabel?(label: string): void;
  registerTool<TParams = unknown, TDetails = Record<string, unknown>>(
    tool: ToolDefinition<TParams, TDetails>,
  ): void;
  registerCommand(name: string, command: CommandDefinition): void;
  on?(event: 'session_start', handler: (event: unknown, ctx: ExtensionContext) => void): void;
  on?(event: 'session_shutdown', handler: () => void): void;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  zod: ZodLike;
}
