#!/usr/bin/env node
/**
 * One-shot importer: copy this proven cam-web project into the EngineerSystem
 * monorepo as `apps/ENG-CAM`.
 *
 * SAFE BY DEFAULT: does nothing without the `--confirm` flag. It is purely
 * additive (creates apps/ENG-CAM), never edits existing EngineerSystem files,
 * and is trivially reversible with `git -C <eng> clean/checkout` or by deleting
 * the folder. Run `--dry-run` first to preview.
 *
 *   node scripts/import-to-engineersystem.mjs --dry-run
 *   node scripts/import-to-engineersystem.mjs --confirm
 *
 * After import (manual, intentional):
 *   1. cd D:\Projects\EngineerSystem && npm install   (registers ENG-CAM workspace)
 *   2. Add a route in apps/ENG-Frontend/src/App.jsx behind <ProtectedRoute>,
 *      lazy-loading ENG-CAM, and a sidebar entry in menu_sidebar.jsx.
 *   3. Keep it a separate bundle so future WASM kernels don't bloat ENG-Frontend.
 */
import { cp, mkdir, stat, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '..'); // cam-web root
const ENG = path.resolve(SRC, '..', 'EngineerSystem');
const DEST = path.join(ENG, 'apps', 'ENG-CAM');

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const confirm = args.has('--confirm');

// Files/dirs copied into apps/ENG-CAM. node_modules/dist/.git are excluded.
const INCLUDE = ['src', 'index.html', 'vite.config.js', 'package.json', 'README.md'];

async function main() {
  if (!existsSync(ENG)) {
    console.error(`✗ EngineerSystem not found at ${ENG}`);
    process.exit(1);
  }
  console.log(`cam-web  : ${SRC}`);
  console.log(`target   : ${DEST}`);

  if (existsSync(DEST)) {
    console.error(`✗ ${DEST} already exists — remove it first or import manually.`);
    process.exit(1);
  }

  const plan = [];
  for (const item of INCLUDE) {
    const from = path.join(SRC, item);
    if (existsSync(from)) plan.push(item);
  }
  console.log(`\nWill copy: ${plan.join(', ')}`);
  console.log('Will rename package "cam-web" -> "eng-cam" for the workspace.');

  if (!confirm) {
    console.log(
      dryRun
        ? '\n[dry-run] no files written. Re-run with --confirm to execute.'
        : '\nNothing done. Re-run with --confirm to execute (or --dry-run to preview).'
    );
    return;
  }

  await mkdir(DEST, { recursive: true });
  for (const item of plan) {
    await cp(path.join(SRC, item), path.join(DEST, item), { recursive: true });
    console.log(`  ✓ ${item}`);
  }

  // Rename the package so the workspace picks it up as ENG-CAM.
  const pkgPath = path.join(DEST, 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
  pkg.name = 'eng-cam';
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log('  ✓ package renamed to eng-cam');

  console.log('\n✓ Imported into apps/ENG-CAM. Next: `cd EngineerSystem && npm install`,');
  console.log('  then add the route + sidebar entry (see header of this script).');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
