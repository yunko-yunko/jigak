import { readdir, mkdir, copyFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

async function copy(directory) {
  for (const entry of await readdir(directory, {
    withFileTypes: true,
  })) {
    const source = join(directory, entry.name);

    if (entry.isDirectory()) {
      await copy(source);
    } else if (['.sql', '.json', '.csv'].includes(extname(entry.name))) {
      const destination = join('dist', source.slice(4));

      await mkdir(join(destination, '..'), {
        recursive: true,
      });

      await copyFile(source, destination);
    }
  }
}

await copy('src');
