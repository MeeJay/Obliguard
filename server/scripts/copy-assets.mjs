// Copie dans dist/ les fichiers de src/ que tsc ignore.
//
// tsc ne traite que les .ts : un fichier lu à l'exécution, comme le script
// d'enrôlement PowerShell du module M365, manquerait de l'image de production,
// qui ne copie que server/dist/. Cette étape est appelée par `npm run build`.
//
// rootDir vaut "." et outDir "dist", donc src/a/b.ps1 devient dist/src/a/b.ps1.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(SERVER_ROOT, 'src');
const OUT = path.join(SERVER_ROOT, 'dist', 'src');

/** Extensions à embarquer. Liste explicite : un fichier oublié est plus visible qu'un fichier copié par erreur. */
const ASSET_EXTENSIONS = new Set(['.ps1', '.sh', '.sql', '.html', '.txt']);

async function* walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

const copied = [];
for await (const file of walk(SRC)) {
  if (!ASSET_EXTENSIONS.has(path.extname(file))) continue;
  const target = path.join(OUT, path.relative(SRC, file));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(file, target);
  copied.push(path.relative(SERVER_ROOT, target));
}

console.log(copied.length ? `Assets copiés :\n  ${copied.join('\n  ')}` : 'Aucun asset à copier.');
