const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const nodeModulesDir = path.join(rootDir, 'node_modules');
const hashMarkerPath = path.join(nodeModulesDir, '.file-management-deps.hash');
const syncGuardEnv = 'FILE_MGMT_SKIP_DEP_SYNC';

function buildDependencyHash() {
    const hash = crypto.createHash('sha256');
    const trackedFiles = ['package.json', 'package-lock.json']
        .map(fileName => path.join(rootDir, fileName))
        .filter(filePath => fs.existsSync(filePath));

    trackedFiles.forEach(filePath => {
        hash.update(fs.readFileSync(filePath));
    });

    return hash.digest('hex');
}

function readRecordedHash() {
    if (!fs.existsSync(hashMarkerPath)) {
        return '';
    }

    return fs.readFileSync(hashMarkerPath, 'utf8').trim();
}

function shouldSyncDependencies(expectedHash) {
    if (!fs.existsSync(nodeModulesDir)) {
        return true;
    }

    const currentHash = readRecordedHash();
    if (currentHash !== expectedHash) {
        return true;
    }

    return false;
}

function runInstall(expectedHash) {
    console.log('[deps] Backend dependencies changed. Running npm install...');

    const result = spawnSync('npm', ['install', '--no-fund', '--no-audit'], {
        cwd: rootDir,
        stdio: 'inherit',
        env: {
            ...process.env,
            [syncGuardEnv]: '1'
        }
    });

    if (result.status !== 0) {
        process.exit(result.status || 1);
    }

    fs.mkdirSync(nodeModulesDir, { recursive: true });
    fs.writeFileSync(hashMarkerPath, `${expectedHash}\n`, 'utf8');
    console.log('[deps] Backend dependencies synchronized.');
}

function main() {
    if (process.env[syncGuardEnv] === '1') {
        return;
    }

    const expectedHash = buildDependencyHash();

    if (!shouldSyncDependencies(expectedHash)) {
        return;
    }

    runInstall(expectedHash);
}

main();
