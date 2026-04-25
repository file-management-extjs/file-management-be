const os = require('os');
const path = require('path');

module.exports = {
    storage: {
        provider: process.env.STORAGE_PROVIDER || 'local',
        localRoot: process.env.STORAGE_ROOT || path.join(__dirname, '../public/uploads'),
        tempRoot: process.env.STORAGE_TEMP_ROOT || path.join(os.tmpdir(), 'file-management-storage'),
        defaultQuotaBytes: parseInt(process.env.STORAGE_QUOTA_BYTES || `${15 * 1024 * 1024 * 1024}`, 10),
        minio: {
            endPoint: process.env.MINIO_ENDPOINT || 'localhost',
            port: parseInt(process.env.MINIO_PORT || '9000', 10),
            useSSL: process.env.MINIO_USE_SSL === 'true',
            accessKey: process.env.MINIO_ACCESS_KEY || 'fileadmin',
            secretKey: process.env.MINIO_SECRET_KEY || 'fileadmin123',
            bucket: process.env.MINIO_BUCKET || 'file-management'
        }
    },
    virusScanning: {
        enabled: process.env.ENABLE_VIRUS_SCANNING === 'true',
        redis: {
            host: process.env.REDIS_HOST || 'localhost',
            port: process.env.REDIS_PORT || 6379,
            db: process.env.REDIS_DB || 0,
            password: process.env.REDIS_PASSWORD
        }
    },
    mediaConversion: {
        serviceUrl: process.env.MEDIA_CONVERTER_URL || 'http://localhost:4100',
        workRoot: process.env.MEDIA_CONVERSION_WORK_ROOT || path.join(os.tmpdir(), 'file-management-media-conversion'),
        requestTimeoutMs: parseInt(process.env.MEDIA_CONVERSION_REQUEST_TIMEOUT_MS || `${16 * 60 * 1000}`, 10)
    },
    documentConversion: {
        workRoot: process.env.DOCUMENT_CONVERSION_WORK_ROOT || path.join(os.tmpdir(), 'file-management-document-conversion'),
        commandTimeoutMs: parseInt(process.env.DOCUMENT_CONVERSION_COMMAND_TIMEOUT_MS || `${12 * 60 * 1000}`, 10)
    },
    contentIntelligence: {
        serviceUrl: process.env.CONTENT_INTELLIGENCE_SERVICE_URL || 'http://localhost:4200',
        workRoot: process.env.CONTENT_INTELLIGENCE_WORK_ROOT || path.join(os.tmpdir(), 'file-management-content-intelligence'),
        commandTimeoutMs: parseInt(process.env.CONTENT_INTELLIGENCE_COMMAND_TIMEOUT_MS || `${8 * 60 * 1000}`, 10),
        requestTimeoutMs: parseInt(process.env.CONTENT_INTELLIGENCE_REQUEST_TIMEOUT_MS || `${12 * 60 * 1000}`, 10)
    }
};
