const fs = require('fs-extra');
const path = require('path');

class LocalStorageProvider {
    constructor(options) {
        this.root = options.root;
        this.providerName = 'local';
        this.bucket = null;
    }

    async ensureReady() {
        await fs.ensureDir(this.root);
    }

    resolveKey(key) {
        const normalizedKey = path.normalize(key || '').replace(/^(\.\.(\/|\\|$))+/, '');
        const absolutePath = path.resolve(this.root, normalizedKey);
        const rootPath = path.resolve(this.root);

        if (!absolutePath.startsWith(rootPath)) {
            throw new Error('Invalid storage key');
        }

        return absolutePath;
    }

    async fPutObject(key, filePath) {
        await this.ensureReady();
        const targetPath = this.resolveKey(key);
        await fs.ensureDir(path.dirname(targetPath));
        await fs.copy(filePath, targetPath);
    }

    async fGetObject(key, destinationPath) {
        const sourcePath = this.resolveKey(key);
        await fs.ensureDir(path.dirname(destinationPath));
        await fs.copy(sourcePath, destinationPath);
    }

    async putObject(key, data) {
        await this.ensureReady();
        const targetPath = this.resolveKey(key);
        await fs.ensureDir(path.dirname(targetPath));
        await fs.writeFile(targetPath, data);
    }

    createReadStream(key, options = {}) {
        const sourcePath = this.resolveKey(key);
        return fs.createReadStream(sourcePath, options);
    }

    async statObject(key) {
        return fs.stat(this.resolveKey(key));
    }

    async removeObject(key) {
        await fs.remove(this.resolveKey(key));
    }

    async exists(key) {
        return fs.pathExists(this.resolveKey(key));
    }

    getAbsolutePath(key) {
        return this.resolveKey(key);
    }
}

module.exports = LocalStorageProvider;
