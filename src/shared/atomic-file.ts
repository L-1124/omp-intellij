import { rename } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

export async function replaceFile(source: string, target: string): Promise<void> {
  const deadline = Date.now() + 1000;
  for (;;) {
    try {
      await rename(source, target);
      return;
    } catch (error: unknown) {
      // Windows readers can temporarily deny replacement of an otherwise writable record.
      if (
        process.platform !== 'win32' ||
        Date.now() >= deadline ||
        !error ||
        typeof error !== 'object' ||
        !('code' in error) ||
        (error.code !== 'EPERM' && error.code !== 'EACCES')
      )
        throw error;
      await sleep(10);
    }
  }
}
