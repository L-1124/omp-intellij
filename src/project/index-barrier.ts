import { encode } from '../shared/protocol.js';
import { type FailureDetail, sanitizeStatus, sanitizeString } from '../shared/runtime-status.js';
import { reduceConnectionState, type StateRecord } from './connection-state.js';

export { reduceConnectionState };

const REQUEST_FAILED = -32803;
const REQUEST_CANCELLED = -32800;
const CONTENT_MODIFIED = -32801;

interface PendingEntry {
  message: { id: unknown; method?: string; params?: Record<string, unknown> };
  frame: Buffer;
  timer: NodeJS.Timeout;
  startTime: number;
}

export class IndexBarrier {
  sendServer: (frame: Buffer) => void;
  sendClient: (frame: Buffer) => void;
  requestWaitTimeoutMs: number;
  onStateChange: ((state: StateRecord) => void) | null;
  ready: boolean;
  failure: string | null;
  failureKind?: string;
  pending: Map<unknown, PendingEntry>;
  queuedBytes: number;
  root: string | null;
  initializeRequestId: unknown;
  state: StateRecord;

  constructor(options: {
    sendServer: (frame: Buffer) => void;
    sendClient: (frame: Buffer) => void;
    requestWaitTimeoutMs?: number;
    waitMs?: number;
    onStateChange?: (state: StateRecord) => void;
  }) {
    const timeout = options.requestWaitTimeoutMs ?? options.waitMs ?? 300000;
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new Error('requestWaitTimeoutMs must be positive');
    }
    this.sendServer = options.sendServer;
    this.sendClient = options.sendClient;
    this.requestWaitTimeoutMs = timeout;
    this.onStateChange = options.onStateChange ?? null;
    this.ready = false;
    this.failure = null;
    this.failureKind = undefined;
    this.pending = new Map();
    this.queuedBytes = 0;
    this.root = null;
    this.initializeRequestId = null;
    this.state = {
      phase: 'connecting',
      detail: '',
      progress: null,
      rootUri: null,
      initializeRequestId: null,
      generation: 0,
    };
  }

  getState(): StateRecord {
    return { ...this.state };
  }

  _applyState(
    message: Record<string, unknown> | null | undefined,
    direction: 'client' | 'server',
  ): void {
    const prev = this.state;
    const next = reduceConnectionState(prev, message, direction);
    this.state = next;

    if (next.phase === 'ready') {
      this.ready = true;
    } else if (next.phase === 'failed') {
      this.ready = false;
      this.failure = next.detail;
      this.failureKind = next.failure?.kind;
    } else {
      this.ready = false;
    }

    if (
      this.onStateChange &&
      (prev.phase !== next.phase ||
        prev.detail !== next.detail ||
        prev.progress !== next.progress ||
        prev.rootUri !== next.rootUri ||
        prev.generation !== next.generation ||
        prev.failure !== next.failure ||
        prev.license !== next.license)
    ) {
      try {
        this.onStateChange({ ...this.state });
      } catch (err) {
        const safeErrMsg =
          err instanceof Error ? sanitizeString(err.message) : sanitizeString(String(err));
        console.error(`IndexBarrier onStateChange error: ${safeErrMsg}`);
      }
    }
  }

  take(id: unknown): PendingEntry | null {
    const entry = this.pending.get(id);
    if (!entry) return null;
    this.pending.delete(id);
    this.queuedBytes -= entry.frame.length;
    clearTimeout(entry.timer);
    return entry;
  }

  reject(message: { id: unknown }, code: number, reason: string, failure?: FailureDetail): void {
    const safeReason = sanitizeString(reason);
    const safeRootUri = typeof this.root === 'string' ? sanitizeString(this.root) : this.root;
    const errorData: Record<string, unknown> = {
      reason: 'intellij-index-not-ready',
      rootUri: safeRootUri,
    };
    const effectiveFailure = failure ?? this.state.failure;
    if (effectiveFailure) {
      errorData.failure = sanitizeStatus(effectiveFailure);
    }
    this.sendClient(
      encode({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code,
          message: safeReason,
          data: errorData,
        },
      }),
    );
  }

  rejectTimeout(message: { id: unknown }, elapsed: number): void {
    const safeRootUri = typeof this.root === 'string' ? sanitizeString(this.root) : this.root;
    this.sendClient(
      encode({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: REQUEST_FAILED,
          message: `IntelliJ project index was not ready within ${this.requestWaitTimeoutMs}ms; retry after indexing completes`,
          data: {
            reason: 'request-wait-timeout',
            rootUri: safeRootUri,
            phase: this.state.phase,
            elapsed,
            projectStillIndexing: true,
          },
        },
      }),
    );
  }

  fail(reason: string, failure?: FailureDetail): void {
    this.ready = false;
    this.failure = reason;
    const effectiveFailure = failure ?? this.state.failure;
    this.failureKind = effectiveFailure?.kind;

    if (this.state.phase !== 'disconnected') {
      if (effectiveFailure?.kind !== 'authorization') {
        this.state.phase = 'failed';
      }
      this.state.detail = reason;
      if (effectiveFailure) {
        this.state.failure = effectiveFailure;
      }
      if (this.onStateChange) {
        try {
          this.onStateChange({ ...this.state });
        } catch (err) {
          const safeErrMsg =
            err instanceof Error ? sanitizeString(err.message) : sanitizeString(String(err));
          console.error(`IndexBarrier onStateChange error: ${safeErrMsg}`);
        }
      }
    }
    for (const id of Array.from(this.pending.keys())) {
      const entry = this.take(id);
      if (entry) {
        this.reject(entry.message, REQUEST_FAILED, reason, effectiveFailure);
      }
    }
  }

  fromClient(message: Record<string, unknown>, frame: Buffer): void {
    if (message.method === 'initialize') {
      const params = message.params as
        | { rootUri?: string; rootPath?: string; workspaceFolders?: Array<{ uri: string }> }
        | undefined;
      this.root = params?.rootUri || params?.workspaceFolders?.[0]?.uri || params?.rootPath || null;
      this.initializeRequestId = message.id ?? null;
      this.ready = false;
      this.failure = null;
      this.failureKind = undefined;
      this._applyState(message, 'client');
      this.sendServer(frame);
      return;
    }
    if (message.method === 'shutdown' || message.method === 'exit') {
      this.fail('IntelliJ connection is shutting down');
      this._applyState(message, 'client');
      this.sendServer(frame);
      return;
    }
    if (message.method === '$/cancelRequest') {
      const params = message.params as { id?: unknown } | undefined;
      if (params?.id !== undefined && this.pending.has(params.id)) {
        const entry = this.take(params.id);
        if (entry) {
          this.reject(
            entry.message,
            REQUEST_CANCELLED,
            'Request cancelled while waiting for IntelliJ index readiness',
          );
        }
        return;
      }
    }
    if (message.method === 'textDocument/didChange' || message.method === 'textDocument/didClose') {
      const params = message.params as { textDocument?: { uri: string } } | undefined;
      const uri = params?.textDocument?.uri;
      for (const [id, entry] of Array.from(this.pending.entries())) {
        const entryParams = entry.message.params as { textDocument?: { uri: string } } | undefined;
        if (!entryParams?.textDocument || entryParams.textDocument.uri === uri) {
          this.take(id);
          this.reject(
            entry.message,
            CONTENT_MODIFIED,
            'Document changed while the request was waiting for IntelliJ indexing; retry with the current document',
          );
        }
      }
    }
    if (message.method === 'workspace/didChangeWorkspaceFolders') {
      this.fail('Workspace folders changed during index-readiness wait; retry after import');
      this.failure = null;
      this.failureKind = undefined;
      this._applyState(message, 'client');
    }
    if (!message.method || message.id === undefined || this.ready) {
      this.sendServer(frame);
      return;
    }
    if (this.failure) {
      this.reject(message as { id: unknown }, REQUEST_FAILED, this.failure, this.state.failure);
      return;
    }
    if (this.pending.size >= 128 || this.queuedBytes + frame.length > 16 * 1024 * 1024) {
      this.reject(
        message as { id: unknown },
        REQUEST_FAILED,
        'Too many requests waiting for IntelliJ index readiness',
      );
      return;
    }
    if (this.pending.has(message.id)) throw new Error('Duplicate pending JSON-RPC request id');

    const startTime = Date.now();
    const timer = setTimeout(() => {
      const entry = this.take(message.id);
      if (entry) {
        const elapsed = Date.now() - entry.startTime;
        this.rejectTimeout(entry.message, elapsed);
      }
    }, this.requestWaitTimeoutMs);
    timer.unref();
    this.pending.set(message.id, {
      message: message as { id: unknown; method?: string; params?: Record<string, unknown> },
      frame,
      timer,
      startTime,
    });
    this.queuedBytes += frame.length;
  }

  fromServer(message: Record<string, unknown>, frame: Buffer): void {
    this.sendClient(frame);
    this._applyState(message, 'server');

    const isInitResponse =
      this.initializeRequestId !== undefined &&
      this.initializeRequestId !== null &&
      message.id === this.initializeRequestId &&
      !message.method;

    if (isInitResponse && message.error) {
      this.fail(this.state.detail, this.state.failure);
      return;
    }

    if (message.method === 'intellij/workspaceImportState') {
      if (this.state.phase === 'failed') {
        this.fail(this.state.detail, this.state.failure);
        return;
      } else if (this.state.phase === 'indexing') {
        if (this.failureKind === 'import' || this.failureKind === 'cancelled') {
          this.failure = null;
          this.failureKind = undefined;
        }
      } else if (this.state.phase !== 'ready') {
        this.ready = false;
        if (this.failureKind === 'import' || this.failureKind === 'cancelled') {
          this.failure = null;
          this.failureKind = undefined;
        }
      }
    }

    if (message.method === 'jetbrains/licensing/state') {
      if (
        this.state.license?.featuresDeclined ||
        this.state.license?.status === 'needs-activation' ||
        this.state.license?.status === 'expired'
      ) {
        const authReason =
          this.state.failure?.kind === 'authorization'
            ? this.state.failure.message
            : this.state.license?.reason || 'IntelliJ authorization denied';
        this.fail(
          this.state.failure?.message || authReason,
          this.state.failure ?? {
            kind: 'authorization',
            stage: 'initialize',
            message: authReason,
          },
        );
        return;
      } else if (this.state.license?.status === 'valid') {
        if (this.failureKind === 'authorization') {
          this.failure = null;
          this.failureKind = undefined;
        }
      }
    }

    if (this.ready && !this.failure) {
      this.ready = true;
      for (const id of Array.from(this.pending.keys())) {
        const entry = this.take(id);
        if (entry) {
          this.sendServer(entry.frame);
        }
      }
    }
  }

  dispose(): void {
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
    this.queuedBytes = 0;
  }
}
