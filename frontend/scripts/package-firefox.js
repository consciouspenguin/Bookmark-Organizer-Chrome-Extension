import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const rootDir = resolve(import.meta.dirname, '..');
const repoDir = resolve(rootDir, '..');
const distDir = join(rootDir, 'dist');
const pkgPath = join(rootDir, 'package.json');
const manifestPath = join(distDir, 'manifest.json');

if (!existsSync(manifestPath)) {
    console.error('Error: dist/manifest.json not found. Run npm run build:firefox first.');
    process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (!manifest.sidebar_action || !manifest.browser_specific_settings) {
    console.error('Error: dist/manifest.json is not a valid Firefox manifest. Run npm run build:firefox first.');
    process.exit(1);
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const version = pkg.version || '1.0.0';

const extZipName = `bookmark-organizer-firefox-v${version}.zip`;
const sourceZipName = `bookmark-organizer-firefox-source-v${version}.zip`;
const extZipPath = join(distDir, extZipName);
const sourceZipPath = join(distDir, sourceZipName);

// 1. Package extension build zip
if (existsSync(extZipPath)) rmSync(extZipPath);

console.log(`Packaging extension to dist/${extZipName}...`);
execFileSync('zip', ['-r', extZipPath, '.', '-x', '*.DS_Store', '*.zip'], {
    cwd: distDir,
    stdio: 'inherit'
});
console.log(`Extension package created: dist/${extZipName}`);

// 2. Package source zip for AMO
if (existsSync(sourceZipPath)) rmSync(sourceZipPath);

console.log(`Packaging source code to dist/${sourceZipName}...`);
execFileSync('zip', [
    '-r',
    sourceZipPath,
    'frontend',
    'README.md',
    'LICENSE',
    '-x',
    'frontend/node_modules/*',
    'frontend/dist/*',
    'frontend/.DS_Store',
    '*.DS_Store'
], {
    cwd: repoDir,
    stdio: 'inherit'
});
console.log(`Source code package created: dist/${sourceZipName}`);
console.log('Packaging complete!');
