export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

export interface XmlAttribute {
  value: string;
  start: number;
  end: number;
}

export interface XmlElement {
  name: string;
  attributes: Record<string, XmlAttribute>;
  parent?: XmlElement;
  children?: XmlElement[];
  start: number;
  end: number;
}

export interface ResolveResourceDefinitionOptions {
  moduleRoot: string;
  variant: string;
  namespace: string;
  type: string;
  name: string;
  readDocument?: (path: string) => Promise<string>;
  documentPaths?: readonly string[];
}
