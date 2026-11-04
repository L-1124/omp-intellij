import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encode, frameParser } from './protocol.js';

interface Position {
  line: number;
  character: number;
}

interface Definition {
  uri: string;
  text: string;
  position: Position;
  generation: number;
  cancelled: boolean;
  timer: NodeJS.Timeout;
  response?: { message: Record<string, unknown>; frame: Buffer };
}

export interface DefinitionInput {
  fileUri: string;
  text: string;
  position: Position;
  upstreamResult: unknown;
}

function documentKey(uri: string): string {
  const path = normalize(fileURLToPath(uri));
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function offset(text: string, position: Position): number {
  if (!Number.isSafeInteger(position.line) || position.line < 0)
    throw new Error('Invalid document line');
  let start = 0;
  for (let line = 0; line < position.line; line++) {
    const end = text.indexOf('\n', start);
    if (end < 0) throw new Error('Document position is outside the text');
    start = end + 1;
  }
  const newline = text.indexOf('\n', start);
  const end = newline < 0 ? text.length : newline;
  if (
    !Number.isSafeInteger(position.character) ||
    position.character < 0 ||
    start + position.character > end
  ) {
    throw new Error('Document character is outside the line');
  }
  return start + position.character;
}

/** Keeps optional navigation work off the server's ordered response stream. */
export class NavigationRelay {
  private readonly documents = new Map<string, { text: string; version: number }>();
  private readonly invalidDocuments = new Set<string>();
  private readonly definitions = new Map<unknown, Definition>();
  private readonly calls = new Map<
    string,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private readonly prefix = `omp-navigation-${randomUUID()}-`;
  private sequence = 0;
  private generation = 0;
  private closed = false;

  constructor(
    private readonly options: {
      sendServer: (message: Record<string, unknown>, frame: Buffer) => void;
      sendClient: (frame: Buffer) => void;
      resolve: (input: DefinitionInput) => Promise<unknown[] | null>;
      invalidate: () => void;
      timeoutMs: number;
    },
  ) {}

  readonly readDocument = async (uri: string): Promise<string> => {
    const key = documentKey(uri);
    if (this.invalidDocuments.has(key)) throw new Error('Document synchronization was lost');
    const document = this.documents.get(key);
    return document ? document.text : readFile(fileURLToPath(uri), 'utf8');
  };
  readonly documentPaths = (): readonly string[] => [
    ...this.documents.keys(),
    ...this.invalidDocuments,
  ];

  readonly request = (method: string, params: unknown): Promise<unknown> => {
    if (this.closed) return Promise.reject(new Error('Navigation connection closed'));
    const id = `${this.prefix}${this.sequence++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.calls.delete(id);
          const cancel = { jsonrpc: '2.0', method: '$/cancelRequest', params: { id } };
          this.options.sendServer(cancel, encode(cancel));
          reject(new Error(`Navigation request ${method} timed out`));
        },
        Math.min(this.options.timeoutMs, 10000),
      );
      timer.unref();
      this.calls.set(id, { resolve, reject, timer });
      const message = { jsonrpc: '2.0', id, method, params };
      this.options.sendServer(message, encode(message));
    });
  };

  async fromClient(message: Record<string, unknown>): Promise<void> {
    const params = message.params as
      | {
          id?: unknown;
          textDocument?: { uri?: string; text?: string; version?: number };
          contentChanges?: Array<{ text: string; range?: { start: Position; end: Position } }>;
          position?: Position;
        }
      | undefined;
    const uri = params?.textDocument?.uri;
    if (message.method === '$/cancelRequest') {
      const entry = this.definitions.get(params?.id);
      if (entry) {
        entry.cancelled = true;
        if (entry.response) this.finish(entry.response.message, entry.response.frame, entry);
      }
      return;
    }
    if (
      typeof message.method === 'string' &&
      (message.method.startsWith('workspace/didChange') ||
        message.method === 'intellij/reloadWorkspace')
    ) {
      this.invalidate();
    }
    if (typeof uri !== 'string') return;
    let key: string;
    try {
      key = documentKey(uri);
    } catch {
      return;
    }
    if (
      message.method === 'textDocument/didOpen' ||
      message.method === 'textDocument/didChange' ||
      message.method === 'textDocument/didClose'
    ) {
      this.invalidate();
      if (message.method === 'textDocument/didClose') {
        this.documents.delete(key);
        this.invalidDocuments.delete(key);
      } else if (message.method === 'textDocument/didOpen') {
        if (typeof params?.textDocument?.text === 'string') {
          this.documents.set(key, {
            text: params.textDocument.text,
            version: params.textDocument.version ?? 0,
          });
          this.invalidDocuments.delete(key);
        }
      } else {
        const previous = this.documents.get(key);
        const version = params?.textDocument?.version;
        if (!previous || typeof version !== 'number' || version <= previous.version) {
          this.documents.delete(key);
          this.invalidDocuments.add(key);
          return;
        }
        try {
          let text = previous.text;
          for (const change of params?.contentChanges ?? []) {
            if (typeof change.text !== 'string') throw new Error('Invalid text change');
            if (!change.range) text = change.text;
            else {
              const start = offset(text, change.range.start);
              const end = offset(text, change.range.end);
              if (end < start) throw new Error('Reversed text range');
              text = text.slice(0, start) + change.text + text.slice(end);
            }
          }
          this.documents.set(key, { text, version });
        } catch {
          this.documents.delete(key);
          this.invalidDocuments.add(key);
        }
      }
      return;
    }
    if (
      message.method !== 'textDocument/definition' ||
      message.id === undefined ||
      this.definitions.size >= 128
    )
      return;
    const position = params?.position;
    if (
      !position ||
      !Number.isSafeInteger(position.line) ||
      position.line < 0 ||
      !Number.isSafeInteger(position.character) ||
      position.character < 0
    )
      return;
    if (!/\.(?:kt|java|xml)$/i.test(uri)) return;
    try {
      const text = await this.readDocument(uri);
      offset(text, position);
      const timer = setTimeout(() => this.definitions.delete(message.id), this.options.timeoutMs);
      timer.unref();
      this.definitions.set(message.id, {
        uri,
        text,
        position,
        generation: this.generation,
        cancelled: false,
        timer,
      });
    } catch {
      // Files without a readable document retain native navigation.
    }
  }

  receive(frame: Buffer): void {
    frameParser((raw) => {
      const message = raw as Record<string, unknown>;
      if (message?.method === 'intellij/workspaceImportState') {
        this.options.invalidate();
        const phase = (message.params as { phase?: string } | undefined)?.phase;
        if (phase !== 'FINISHED' && phase !== 'SUCCESS') {
          for (const entry of this.definitions.values()) {
            if (!entry.response) continue;
            entry.generation = -1;
            this.finish(entry.response.message, entry.response.frame, entry);
          }
        }
      }
      if (!message || message.method || message.id === undefined) {
        this.options.sendClient(frame);
        return;
      }
      if (typeof message.id === 'string' && message.id.startsWith(this.prefix)) {
        const call = this.calls.get(message.id);
        if (call) {
          this.calls.delete(message.id);
          clearTimeout(call.timer);
          if (message.error !== undefined)
            call.reject(new Error('Native navigation request failed'));
          else call.resolve(message.result);
        }
        return;
      }
      const entry = this.definitions.get(message.id);
      if (!entry) {
        this.options.sendClient(frame);
        return;
      }
      if (message.error !== undefined || entry.cancelled || entry.generation !== this.generation) {
        this.finish(message, frame, entry);
        return;
      }
      clearTimeout(entry.timer);
      entry.response = { message, frame };
      entry.timer = setTimeout(
        () => this.finish(message, frame, entry),
        Math.min(this.options.timeoutMs, 10000),
      );
      entry.timer.unref();
      void this.resolve(message, frame, entry);
    })(frame);
  }
  private invalidate(): void {
    this.generation++;
    this.options.invalidate();
    for (const entry of this.definitions.values()) {
      if (entry.response) this.finish(entry.response.message, entry.response.frame, entry);
    }
  }

  private finish(message: Record<string, unknown>, frame: Buffer, entry: Definition): void {
    if (this.definitions.get(message.id) !== entry) return;
    this.definitions.delete(message.id);
    clearTimeout(entry.timer);
    if (this.closed) return;
    if (message.error !== undefined) this.options.sendClient(frame);
    else if (entry.cancelled || entry.generation !== this.generation) {
      this.options.sendClient(
        encode({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: entry.cancelled ? -32800 : -32801,
            message: entry.cancelled
              ? 'Request cancelled'
              : 'Document or workspace changed during navigation',
          },
        }),
      );
    } else this.options.sendClient(frame);
  }

  private async resolve(
    message: Record<string, unknown>,
    frame: Buffer,
    entry: Definition,
  ): Promise<void> {
    let result: unknown[] | null = null;
    try {
      result = await this.options.resolve({
        fileUri: entry.uri,
        text: entry.text,
        position: entry.position,
        upstreamResult: message.result,
      });
      if (result?.length && (await this.readDocument(entry.uri)) !== entry.text)
        entry.generation = -1;
    } catch {
      // Optional Android resolution must never hide a native result.
      result = null;
    }
    this.finish(message, result?.length ? encode({ ...message, result }) : frame, entry);
  }

  close(): void {
    this.closed = true;
    for (const entry of this.definitions.values()) clearTimeout(entry.timer);
    this.definitions.clear();
    for (const call of this.calls.values()) {
      clearTimeout(call.timer);
      call.reject(new Error('Navigation connection closed'));
    }
    this.calls.clear();
    this.documents.clear();
    this.invalidDocuments.clear();
  }
}
