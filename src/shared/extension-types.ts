import type {
  ExtensionAPI,
  ExtensionUIContext,
  ExtensionContext as SDKContext,
  SessionShutdownEvent,
  SessionStartEvent,
  SessionSwitchEvent,
} from '@oh-my-pi/pi-coding-agent';

export type ExtensionUI = Pick<ExtensionUIContext, 'notify'> &
  Partial<Pick<ExtensionUIContext, 'confirm' | 'formDialog' | 'select' | 'setStatus'>>;

export interface ExtensionContext extends Pick<SDKContext, 'cwd'> {
  agent?: {
    kind?: string;
  };
  ui?: ExtensionUI;
}

export interface CommandDefinition
  extends Pick<Parameters<ExtensionAPI['registerCommand']>[1], 'getArgumentCompletions'> {
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

export interface ExtensionSessionEvents {
  session_start: SessionStartEvent;
  session_switch: SessionSwitchEvent;
  session_shutdown: SessionShutdownEvent;
}

export type ExtensionSessionHandler<K extends keyof ExtensionSessionEvents> = (
  event: ExtensionSessionEvents[K],
  ctx: ExtensionContext,
) => void | Promise<void>;

export interface ExtensionPluginInstance {
  setLabel?(label: string): void;
  registerTool: ExtensionAPI['registerTool'];
  registerCommand(name: string, command: CommandDefinition): void;
  on?(event: 'session_start', handler: ExtensionSessionHandler<'session_start'>): void;
  on?(event: 'session_switch', handler: ExtensionSessionHandler<'session_switch'>): void;
  on?(event: 'session_shutdown', handler: ExtensionSessionHandler<'session_shutdown'>): void;
  zod: ZodLike;
}
