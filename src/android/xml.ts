import { pathToFileURL } from 'node:url';
import { SaxesParser } from 'saxes';
import type { LspLocation, LspPosition, XmlElement } from './types.js';

export type { LspLocation, LspPosition, LspRange, XmlAttribute, XmlElement } from './types.js';

/** Preserve source offsets rather than decoded XML value lengths. */
export function parseXml(text: string): XmlElement[] {
  const parser = new SaxesParser();
  const elements: XmlElement[] = [];
  const stack: XmlElement[] = [];
  let parseError: Error | null = null;

  parser.on('error', (err) => {
    parseError = err;
  });

  parser.on('doctype', () => {
    parseError = new Error('DTD and external entities are forbidden');
  });

  parser.on('opentagstart', (tag) => {
    if (parseError) {
      return;
    }
    let p = parser.position - 1;
    while (p >= 0 && text.charCodeAt(p) !== 60) {
      p--;
    }
    const parent = stack.length > 0 ? stack[stack.length - 1] : undefined;
    const el: XmlElement = {
      name: tag.name,
      attributes: Object.create(null),
      parent,
      children: [],
      start: Math.max(0, p),
      end: 0,
    };
    if (parent?.children) {
      parent.children.push(el);
    }
    stack.push(el);
    elements.push(el);
  });

  parser.on('attribute', (attr) => {
    if (parseError || stack.length === 0) {
      return;
    }
    const el = stack[stack.length - 1];
    const quoteEnd = parser.position - 1;
    const quoteChar = text.charCodeAt(quoteEnd);
    let quoteStart = quoteEnd - 1;
    while (quoteStart >= 0 && text.charCodeAt(quoteStart) !== quoteChar) {
      quoteStart--;
    }
    const valueStart = quoteStart + 1;
    const valueEnd = quoteEnd;
    el.attributes[attr.name] = {
      value: attr.value,
      start: Math.max(0, valueStart),
      end: Math.max(0, valueEnd),
    };
  });

  parser.on('closetag', () => {
    if (parseError || stack.length === 0) {
      return;
    }
    const el = stack.pop();
    if (el) {
      el.end = parser.position;
    }
  });

  try {
    parser.write(text).close();
  } catch (err) {
    throw parseError || err;
  }

  if (parseError) {
    throw parseError;
  }

  return elements;
}

export function offsetAt(text: string, position: LspPosition): number {
  let currentLine = 0;
  let offset = 0;
  while (currentLine < position.line && offset < text.length) {
    const nextNewline = text.indexOf('\n', offset);
    if (nextNewline === -1) {
      return text.length;
    }
    offset = nextNewline + 1;
    currentLine++;
  }
  return Math.min(offset + Math.max(0, position.character), text.length);
}

export function positionAt(text: string, offset: number): LspPosition {
  const clampedOffset = Math.max(0, Math.min(offset, text.length));
  let line = 0;
  let lastNewline = -1;
  for (let i = 0; i < clampedOffset; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lastNewline = i;
    }
  }
  const character = clampedOffset - (lastNewline + 1);
  return { line, character };
}

export function locationAt(path: string, text: string, start: number, end: number): LspLocation {
  const uri = path.startsWith('file:') || path.startsWith('jar:') ? path : pathToFileURL(path).href;
  return {
    uri,
    range: {
      start: positionAt(text, start),
      end: positionAt(text, end),
    },
  };
}
