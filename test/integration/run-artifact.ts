import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Artifacts outlive their producing sandbox but are never reused across test runs.
export interface RunArtifactStore {
  readonly dir: string;
  materialize(name: string, targetPath: string): Promise<boolean>;
  capture(name: string, sourcePath: string): Promise<void>;
  dispose(): Promise<void>;
}

export async function createRunArtifactStore(
  prefix = 'omp-intellij-run-artifacts-',
): Promise<RunArtifactStore> {
  const dir = await mkdtemp(join(tmpdir(), prefix));

  const materialize = async (name: string, targetPath: string): Promise<boolean> => {
    const artifact = join(dir, name);
    if (!existsSync(artifact)) return false;
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(artifact, targetPath);
    return true;
  };

  const capture = async (name: string, sourcePath: string): Promise<void> => {
    const artifact = join(dir, name);
    // Publish only complete copies, preserving the previous artifact on failure.
    const staged = `${artifact}.${randomUUID()}.partial`;
    try {
      await copyFile(sourcePath, staged);
      await rename(staged, artifact);
    } catch (error) {
      await rm(staged, { force: true });
      throw error;
    }
  };

  const dispose = async (): Promise<void> => {
    await rm(dir, { recursive: true, force: true });
  };

  return { dir, materialize, capture, dispose };
}
