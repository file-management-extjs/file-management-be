const fs = require('fs-extra');
const path = require('path');
const config = require('../../config');
const LocalStorageProvider = require('./localStorageProvider');
const MinioStorageProvider = require('./minioStorageProvider');

class StorageService {
    constructor() {
        this.localProvider = new LocalStorageProvider({ root: config.storage.localRoot });
        this.provider = this.createProvider();
    }

    createProvider() {
        if (config.storage.provider === 'minio') {
            return new MinioStorageProvider(config.storage.minio);
        }

        return this.localProvider;
    }

    get providerName() {
        return this.provider.providerName;
    }

    get bucket() {
        return this.provider.bucket || null;
    }

    isObjectStorage() {
        return this.providerName === 'minio';
    }

    buildFileKey(userId, fileId) {
        return `users/${userId}/files/${fileId}/original`;
    }

    getFileKey(file) {
        return file.storageKey || file.path;
    }

    getProviderForFile(file) {
        if (
            file &&
            this.providerName !== 'local' &&
            (file.storageProvider === 'local' || !file.storageKey)
        ) {
            return this.localProvider;
        }

        return this.provider;
    }

    async uploadFile(file, sourcePath, metadata = {}) {
        const key = this.getFileKey(file);
        await this.getProviderForFile(file).fPutObject(key, sourcePath, metadata);
    }

    async downloadFile(file, destinationPath) {
        await fs.ensureDir(path.dirname(destinationPath));
        await this.getProviderForFile(file).fGetObject(this.getFileKey(file), destinationPath);
    }

    async createReadStream(file, options = {}) {
        return this.getProviderForFile(file).createReadStream(this.getFileKey(file), options);
    }

    async statFile(file) {
        return this.getProviderForFile(file).statObject(this.getFileKey(file));
    }

    async fileExists(file) {
        return this.getProviderForFile(file).exists(this.getFileKey(file));
    }

    async deleteFile(file) {
        const key = this.getFileKey(file);
        const provider = this.getProviderForFile(file);
        if (await provider.exists(key)) {
            await provider.removeObject(key);
        }
    }

    getLocalAbsolutePath(file) {
        const provider = this.getProviderForFile(file);
        if (!provider.getAbsolutePath) {
            return null;
        }

        return provider.getAbsolutePath(this.getFileKey(file));
    }

    async materializeFile(file, destinationPath) {
        const localPath = this.getLocalAbsolutePath(file);
        if (localPath) {
            return localPath;
        }

        await this.downloadFile(file, destinationPath);
        return destinationPath;
    }
}

module.exports = new StorageService();
