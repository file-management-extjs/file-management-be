class MinioStorageProvider {
    constructor(options) {
        let Minio;

        try {
            Minio = require('minio');
        } catch (error) {
            throw new Error('MinIO storage selected, but the "minio" package is not installed. Run npm install in backend or rebuild the backend container.');
        }

        this.providerName = 'minio';
        this.bucket = options.bucket;
        this.client = new Minio.Client({
            endPoint: options.endPoint,
            port: options.port,
            useSSL: options.useSSL,
            accessKey: options.accessKey,
            secretKey: options.secretKey
        });
        this.readyPromise = null;
    }

    async ensureReady() {
        if (this.readyPromise) {
            return this.readyPromise;
        }

        this.readyPromise = (async () => {
            const exists = await this.client.bucketExists(this.bucket);
            if (!exists) {
                await this.client.makeBucket(this.bucket);
            }
        })();

        return this.readyPromise;
    }

    async fPutObject(key, filePath, metadata = {}) {
        await this.ensureReady();
        await this.client.fPutObject(this.bucket, key, filePath, metadata);
    }

    async fGetObject(key, destinationPath) {
        await this.ensureReady();
        await this.client.fGetObject(this.bucket, key, destinationPath);
    }

    async putObject(key, data, size = undefined, metadata = {}) {
        await this.ensureReady();
        await this.client.putObject(this.bucket, key, data, size, metadata);
    }

    async createReadStream(key, options = {}) {
        await this.ensureReady();

        if (Number.isInteger(options.start) && Number.isInteger(options.end)) {
            return this.client.getPartialObject(this.bucket, key, options.start, options.end - options.start + 1);
        }

        return this.client.getObject(this.bucket, key);
    }

    async statObject(key) {
        await this.ensureReady();
        return this.client.statObject(this.bucket, key);
    }

    async removeObject(key) {
        await this.ensureReady();
        await this.client.removeObject(this.bucket, key);
    }

    async exists(key) {
        try {
            await this.statObject(key);
            return true;
        } catch (error) {
            if (error && ['NotFound', 'NoSuchKey'].includes(error.code)) {
                return false;
            }

            throw error;
        }
    }
}

module.exports = MinioStorageProvider;
