import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const namespace = 'com.example.probe';
export interface ResourceFixtureItem {
  source?: 'main' | 'debug';
  folder: string;
  file: string;
  type: string;
  name: string;
  text: string;
}
function xmlEscape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

export async function resourceFixture(items: ResourceFixtureItem[]) {
  const root = await mkdtemp(join(tmpdir(), 'omp-resource-fixture-'));
  const moduleRoot = join(root, 'app');
  const incremental = join(moduleRoot, 'build/intermediates/incremental/debug/mergeDebugResources');
  const merged = join(incremental, 'merged.dir');
  const destination = join(moduleRoot, 'build/intermediates/merged_res/debug/mergeDebugResources');
  const blame = join(
    moduleRoot,
    'build/intermediates/merged_res_blame_folder/debug/mergeDebugResources/out',
  );
  const put = async (path: string, text: string) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  };
  for (const dir of [merged, join(incremental, 'stripped.dir'), destination, join(blame, 'single')])
    await mkdir(dir, { recursive: true });
  const records: Record<string, string[]> = { main: [], debug: [] };
  const single: Array<{ merged: string; source: string }> = [];
  for (const item of items) {
    const source = item.source ?? 'main';
    const path = join(moduleRoot, 'src', source, 'res', item.folder, item.file);
    await put(path, item.text);
    const qualifier = item.folder.includes('-')
      ? item.folder.slice(item.folder.indexOf('-') + 1)
      : '';
    if (item.folder === 'values' || item.folder.startsWith('values-')) {
      records[source].push(
        `<file path="${xmlEscape(path)}" qualifiers="${qualifier}"><${item.type} name="${item.name}" /></file>`,
      );
      const mergedFile = join(
        merged,
        item.folder,
        item.folder === 'values' ? 'values.xml' : `${item.folder}.xml`,
      );
      await put(mergedFile, item.text);
      const start = item.text.indexOf('<', item.text.indexOf('>') + 1);
      await put(
        join(blame, 'multi-v2', `${item.folder}.json`),
        JSON.stringify({
          logs: [
            {
              outputFile: `${namespace}.app-mergeDebugResources-0:/${item.folder}/${item.folder === 'values' ? 'values.xml' : `${item.folder}.xml`}`,
              map: [
                {
                  source: path,
                  from: { startLines: '1' },
                  to: {
                    startOffsets: String(start),
                    endOffsets: String(item.text.lastIndexOf('</resources>') - 1),
                    startLines: '1',
                  },
                },
              ],
            },
          ],
        }),
      );
    } else {
      records[source].push(
        `<file path="${xmlEscape(path)}" qualifiers="${qualifier}" name="${item.name}" type="${item.type}" />`,
      );
      const sourceId = source === 'debug' ? 3 : 4;
      single.push({
        merged: `${namespace}.app-debug-2:/${item.folder}_${item.file}.flat`,
        source: `${namespace}.app-${source}-${sourceId}:/${item.folder}/${item.file}`,
      });
    }
  }
  await put(join(blame, 'single/mergeDebugResources.json'), JSON.stringify(single));
  const merger = join(incremental, 'merger.xml');
  await put(
    merger,
    `<merger version="3">${['main', 'debug'].map((source) => `<dataSet config="${source}"><source path="${xmlEscape(join(moduleRoot, 'src', source, 'res'))}">${records[source].join('')}</source></dataSet>`).join('')}</merger>`,
  );
  await put(
    join(moduleRoot, 'src/main/AndroidManifest.xml'),
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application /></manifest>',
  );
  const jar = join(
    moduleRoot,
    'build/intermediates/compile_and_runtime_r_class_jar/debug/processDebugResources/R.jar',
  );
  const rUri = `jar:${pathToFileURL(jar).href}!/com/example/probe/R.class`;
  return {
    root,
    moduleRoot,
    incremental,
    merged,
    blame,
    merger,
    jar,
    rUri,
    put,
    source: (item: ResourceFixtureItem) =>
      join(moduleRoot, 'src', item.source ?? 'main', 'res', item.folder, item.file),
  };
}
