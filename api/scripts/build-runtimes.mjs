/* global console */
// Сборка рабочего потока PHP/Python для выкладки: dist/worker.js и рядом dist/node_modules
// только с нужными файлами интерпретаторов (PHP 8.3 asyncify, Pyodide). Остальной API — один server.mjs.
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dist = path.resolve('dist');

await build({
  entryPoints: ['src/lib/vhost/worker.js'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: path.join(dist, 'worker.js'),
  external: ['pyodide', '@php-wasm/node-8-3'],
  legalComments: 'none',
  logLevel: 'warning',
  banner: { js: "import { createRequire as __bln_cr } from 'node:module'; const require = __bln_cr(import.meta.url);" },
});

async function copy(pkg, files) {
  const src = path.dirname(require.resolve(`${pkg}/package.json`));
  const dst = path.join(dist, 'node_modules', pkg);
  for (const f of ['package.json', ...files]) {
    await fs.mkdir(path.dirname(path.join(dst, f)), { recursive: true });
    await fs.cp(path.join(src, f), path.join(dst, f), { recursive: true });
  }
}

const phpDir = path.dirname(require.resolve('@php-wasm/node-8-3/package.json'));
const wasmDirs = (await fs.readdir(path.join(phpDir, 'asyncify'))).filter((d) => /^\d/.test(d));
await copy('@php-wasm/node-8-3', ['asyncify/php_8_3.js', ...wasmDirs.map((d) => `asyncify/${d}`)]);
await copy('pyodide', ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json']);
console.log('runtimes: worker.js +', wasmDirs.join(', '), '+ pyodide');
