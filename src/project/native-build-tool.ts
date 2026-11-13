export interface NativeBuildTool {
  tool: string | null;
  env: Record<string, string>;
}

export async function queryNativeBuildTool(
  client: {
    request(
      method: string,
      params: unknown,
      timeoutMs?: number,
      signal?: AbortSignal,
    ): Promise<unknown>;
  },
  uri: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<NativeBuildTool> {
  const raw = await client.request(
    'workspace/executeCommand',
    {
      command: 'intellij.java.buildTool',
      arguments: [{ uri }],
    },
    options.timeoutMs,
    options.signal,
  );
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('intellij.java.buildTool returned an invalid response');
  }
  const result = raw as Record<string, unknown>;
  if (result.tool !== null && (typeof result.tool !== 'string' || !result.tool.trim())) {
    throw new Error('intellij.java.buildTool returned an invalid tool');
  }
  if (
    !result.env ||
    typeof result.env !== 'object' ||
    Array.isArray(result.env) ||
    Object.values(result.env).some((value) => typeof value !== 'string')
  ) {
    throw new Error('intellij.java.buildTool returned an invalid environment');
  }
  return { tool: result.tool as string | null, env: result.env as Record<string, string> };
}
