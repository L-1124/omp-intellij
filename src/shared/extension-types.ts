import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';

export interface SelectItem {
  label: string;
  value: string;
  description?: string;
}

export interface ExtensionUI {
  setStatus?(key: string, text: string): void;
  notify(message: string, level?: 'info' | 'warning' | 'error'): void;
  confirm?(title: string, message: string): Promise<boolean>;
  select?(prompt: string, items: SelectItem[]): Promise<SelectItem | string | undefined | null>;
  theme?: unknown;
}

export interface ExtensionContext {
  cwd: string;
  agent?: {
    kind?: string;
  };
  ui?: ExtensionUI;
}

export interface CommandDefinition {
  description: string;
  handler(rawArgs: string, ctx: ExtensionContext): Promise<void>;
}

export interface ToolContentItem {
  type: 'text';
  text: string;
}

export interface ToolUpdate<TDetails = Record<string, unknown>> {
  content: ToolContentItem[];
  details: TDetails;
}

export interface ToolResult<TDetails = Record<string, unknown>> {
  content: ToolContentItem[];
  details: TDetails;
  isError: boolean;
}

export interface ToolDefinition<TParams = unknown, TDetails = Record<string, unknown>> {
  name: string;
  label: string;
  description: string;
  approval?: 'read' | 'exec';
  parameters: unknown;
  execute(
    id: string,
    params: TParams,
    signal: AbortSignal | undefined,
    onUpdate: ((update: ToolUpdate<TDetails>) => void) | undefined,
    ctx: ExtensionContext,
  ): Promise<ToolResult<TDetails>>;
}

export type ZodLike = ExtensionAPI['zod'];

export interface ExtensionPluginInstance {
  setLabel?(label: string): void;
  registerTool: ExtensionAPI['registerTool'];
  registerCommand(name: string, command: CommandDefinition): void;
  on?(event: 'session_start', handler: (event: unknown, ctx: ExtensionContext) => void): void;
  on?(event: 'session_shutdown', handler: () => void): void;
  zod: ZodLike;
}
