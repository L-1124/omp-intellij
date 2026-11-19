function stripTags(symbols: unknown[]): boolean {
  let changed = false;
  for (const symbol of symbols) {
    if (!symbol || typeof symbol !== 'object') continue;
    if ('tags' in symbol) {
      delete symbol.tags;
      changed = true;
    }
    if ('children' in symbol && Array.isArray(symbol.children)) {
      changed = stripTags(symbol.children) || changed;
    }
  }
  return changed;
}

export class DocumentSymbolAdapter {
  private hierarchical = false;
  private tags = false;
  private readonly pending = new Map<unknown, { uri: string; token: unknown }>();
  private readonly partialResults = new Map<unknown, unknown>();

  fromClient(message: Record<string, unknown>): void {
    const params = message.params as Record<string, unknown> | undefined;
    if (message.method === 'initialize') {
      const capabilities = params?.capabilities as
        | {
            textDocument?: {
              documentSymbol?: {
                hierarchicalDocumentSymbolSupport?: boolean;
                tagSupport?: { valueSet: number[] };
              };
            };
          }
        | undefined;
      const symbols = capabilities?.textDocument?.documentSymbol;
      this.hierarchical = symbols?.hierarchicalDocumentSymbolSupport === true;
      this.tags = symbols?.tagSupport !== undefined;
    } else if (message.method === 'textDocument/documentSymbol' && message.id !== undefined) {
      const document = params?.textDocument as { uri?: string } | undefined;
      if (typeof document?.uri !== 'string') return;
      this.discard(message.id);
      const token = params?.partialResultToken;
      this.pending.set(message.id, { uri: document.uri, token });
      if (typeof token === 'string' || typeof token === 'number') {
        this.partialResults.set(token, message.id);
      }
    }
  }

  fromServer(message: Record<string, unknown>): boolean {
    if (message.method === '$/progress') {
      const params = message.params;
      if (!params || typeof params !== 'object' || !('token' in params) || !('value' in params)) {
        return false;
      }
      if (!this.partialResults.has(params.token)) return false;
      const request = this.pending.get(this.partialResults.get(params.token));
      return request ? this.adapt(params, 'value', request.uri) : false;
    }
    if (message.method) return false;
    const request = this.pending.get(message.id);
    if (!request) return false;
    this.discard(message.id);
    return this.adapt(message, 'result', request.uri);
  }

  private adapt(message: object, key: 'result' | 'value', uri: string): boolean {
    const record = message as Record<string, unknown>;
    const symbols = record[key];
    if (!Array.isArray(symbols)) return false;
    const changed = !this.tags && stripTags(symbols);
    if (
      this.hierarchical ||
      !symbols.some((symbol) => symbol && typeof symbol === 'object' && 'selectionRange' in symbol)
    )
      return changed;
    const result: unknown[] = [];
    const visit = (entries: unknown[], containerName?: unknown) => {
      for (const symbol of entries) {
        if (!symbol || typeof symbol !== 'object' || !('selectionRange' in symbol)) {
          result.push(symbol);
          continue;
        }
        const entry = symbol as Record<string, unknown>;
        result.push({
          name: entry.name,
          kind: entry.kind,
          ...(entry.tags === undefined ? {} : { tags: entry.tags }),
          ...(entry.deprecated === undefined ? {} : { deprecated: entry.deprecated }),
          location: { uri, range: entry.range },
          ...(containerName === undefined ? {} : { containerName }),
        });
        if (Array.isArray(entry.children)) visit(entry.children, entry.name);
      }
    };
    visit(symbols);
    record[key] = result;
    return true;
  }

  discard(id: unknown): void {
    const request = this.pending.get(id);
    if (!request) return;
    if (this.partialResults.get(request.token) === id) this.partialResults.delete(request.token);
    this.pending.delete(id);
  }

  close(): void {
    this.pending.clear();
    this.partialResults.clear();
  }
}
