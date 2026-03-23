import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(import.meta.dirname, '..');
const overrideRoot = path.join(repoRoot, 'overrides', 'claude-to-im');
const targetRoot = path.join(repoRoot, 'node_modules', 'claude-to-im');

function copyTree(sourceDir, destDir) {
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyTree(sourcePath, destPath);
      continue;
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(sourcePath, destPath);
  }
}

if (!fs.existsSync(overrideRoot)) {
  console.error(`[apply-overrides] Missing override directory: ${overrideRoot}`);
  process.exit(1);
}

if (!fs.existsSync(targetRoot)) {
  console.error('[apply-overrides] Dependency claude-to-im is not installed yet. Run `npm install` first.');
  process.exit(1);
}

copyTree(overrideRoot, targetRoot);
console.log(`[apply-overrides] Synced overrides from ${path.relative(repoRoot, overrideRoot)} to ${path.relative(repoRoot, targetRoot)}`);
