interface DocumentSymbol {
  name: string;
  kind: number;
  range: unknown;
  tags?: unknown;
  deprecated?: boolean;
  children?: DocumentSymbol[];
}

export class DocumentSymbolAdapter {
  private hierarchical = false;
  private readonly pending = new Map<unknown, string>();

  fromClient(message: Record<string, unknown>): void {
    const params = message.params as Record<string, unknown> | undefined;
    if (message.method === 'initialize') {
      const capabilities = params?.capabilities as
        | { textDocument?: { documentSymbol?: { hierarchicalDocumentSymbolSupport?: boolean } } }
        | undefined;
      this.hierarchical =
        capabilities?.textDocument?.documentSymbol?.hierarchicalDocumentSymbolSupport === true;
    } else if (
      message.method === 'textDocument/documentSymbol' &&
      message.id !== undefined &&
      !this.hierarchical
    ) {
      const document = params?.textDocument as { uri?: string } | undefined;
      if (typeof document?.uri === 'string') this.pending.set(message.id, document.uri);
    }
  }

  fromServer(message: Record<string, unknown>): boolean {
    if (message.method || !this.pending.has(message.id)) return false;
    const uri = this.pending.get(message.id);
    this.pending.delete(message.id);
    if (!Array.isArray(message.result)) return false;
    if (
      !message.result.some(
        (symbol) => symbol && typeof symbol === 'object' && 'selectionRange' in symbol,
      )
    )
      return false;
    const result: unknown[] = [];
    const visit = (symbols: DocumentSymbol[], containerName?: string) => {
      for (const symbol of symbols) {
        if (!symbol || typeof symbol !== 'object' || !('selectionRange' in symbol)) {
          result.push(symbol);
          continue;
        }
        result.push({
          name: symbol.name,
          kind: symbol.kind,
          ...(symbol.tags === undefined ? {} : { tags: symbol.tags }),
          ...(symbol.deprecated === undefined ? {} : { deprecated: symbol.deprecated }),
          location: { uri, range: symbol.range },
          ...(containerName === undefined ? {} : { containerName }),
        });
        if (symbol.children) visit(symbol.children, symbol.name);
      }
    };
    visit(message.result);
    message.result = result;
    return true;
  }

  close(): void {
    this.pending.clear();
  }
}
