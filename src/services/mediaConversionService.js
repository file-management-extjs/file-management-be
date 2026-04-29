const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const mime = require('mime');
const File = require('../models/fileModel');
const config = require('../config');
const FileService = require('./fileService');
const StorageService = require('./storage/storageService');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

class MediaConversionService {
    static supportedOperations = [
        'convertAudio',
        'convertVideo',
        'convertImage',
        'extractAudio',
        'videoToGif',
        'thumbnail'
    ];

    static createError(message, statusCode = 400, code = null) {
        const error = new Error(message);
        error.statusCode = statusCode;
        if (code) {
            error.code = code;
        }
        return error;
    }

    static createCancelledError() {
        const error = this.createError('Media conversion cancelled.', 499);
        error.cancelled = true;
        return error;
    }

    static sanitizeFilename(filename, fallback = 'converted-media') {
        const base = path.basename(String(filename || fallback)).trim();
        return base.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || fallback;
    }

    static isAudio(file) {
        return String(file.mimetype || mime.getType(file.name) || '').startsWith('audio/');
    }

    static isVideo(file) {
        return String(file.mimetype || mime.getType(file.name) || '').startsWith('video/');
    }

    static isImage(file) {
        return String(file.mimetype || mime.getType(file.name) || '').startsWith('image/');
    }

    static validateOperationForFile(operation, file) {
        if (operation === 'convertAudio' && !this.isAudio(file)) {
            throw this.createError('Select an audio file to convert audio.');
        }

        if (['convertVideo', 'extractAudio', 'videoToGif'].includes(operation) && !this.isVideo(file)) {
            throw this.createError('Select a video file for this operation.');
        }

        if (operation === 'convertImage' && !this.isImage(file)) {
            throw this.createError('Select an image file to convert images.');
        }

        if (operation === 'thumbnail' && !this.isImage(file) && !this.isVideo(file)) {
            throw this.createError('Thumbnails can be generated from images or videos.');
        }
    }

    static async validateRequest(userId, payload = {}) {
        const operation = String(payload.operation || '');

        if (!this.supportedOperations.includes(operation)) {
            throw this.createError('Unsupported media conversion operation.');
        }

        const sourceFile = await this.getOwnedFile(userId, payload.fileId);
        this.validateOperationForFile(operation, sourceFile);

        return {
            operation,
            sourceFile
        };
    }

    static async getOwnedFile(userId, fileId) {
        if (!fileId) {
            throw this.createError('A file is required.');
        }

        const file = await File.findOne({
            _id: fileId,
            userId: userId.toString(),
            deleted: false
        });

        if (!file) {
            throw this.createError('File not found or access denied.', 403);
        }

        try {
            FileService.assertPasswordAccess(file, userId);
        } catch (error) {
            throw this.createError(
                error.message || 'Password verification required.',
                error.statusCode || 403,
                error.code
            );
        }

        return file;
    }

    static async createJobRoot(userId) {
        const root = path.join(config.mediaConversion.workRoot, 'jobs', userId.toString());
        await fs.ensureDir(root);
        return fs.mkdtemp(path.join(root, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-`));
    }

    static getRelativeToWorkRoot(absolutePath) {
        return path.relative(config.mediaConversion.workRoot, absolutePath);
    }

    static async materializeToJob(file, jobRoot) {
        const inputDir = path.join(jobRoot, 'input');
        await fs.ensureDir(inputDir);

        const safeName = this.sanitizeFilename(file.name || file._id.toString());
        const destinationPath = path.join(inputDir, safeName);
        const materializedPath = await StorageService.materializeFile(file, destinationPath);

        if (materializedPath !== destinationPath) {
            await fs.copy(materializedPath, destinationPath);
        }

        return destinationPath;
    }

    static async getOutputTarget(userId, parentId, fallbackParentId = null) {
        const normalizedParentId = parentId === undefined ? fallbackParentId : parentId || null;
        const relativeUploadDir = await FileService.getRelativeUploadDir(userId, normalizedParentId);

        return {
            parentId: normalizedParentId,
            relativeUploadDir
        };
    }

    static async callConverter(payload) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.mediaConversion.requestTimeoutMs);
        let response;

        try {
            response = await fetch(`${config.mediaConversion.serviceUrl}/convert`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload),
                signal: controller.signal
            });
        } catch (error) {
            if (error.name === 'AbortError') {
                throw this.createError('Media converter timed out before the operation completed.', 504);
            }

            throw this.createError('Media converter service is unavailable.', 503);
        } finally {
            clearTimeout(timeout);
        }

        let body = null;
        try {
            body = await response.json();
        } catch (error) {
            body = {};
        }

        if (!response.ok || !body.success) {
            throw this.createError(body.error || 'Media converter service failed.', response.status || 502);
        }

        return body;
    }

    static async requestConverter(pathname, options = {}) {
        const controller = new AbortController();
        const timeoutMs = options.timeoutMs || config.mediaConversion.requestTimeoutMs;
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        let response;

        try {
            response = await fetch(`${config.mediaConversion.serviceUrl}${pathname}`, {
                method: options.method || 'GET',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: options.body ? JSON.stringify(options.body) : undefined,
                signal: controller.signal
            });
        } catch (error) {
            if (error.name === 'AbortError') {
                throw this.createError('Media converter timed out before responding.', 504);
            }

            throw this.createError('Media converter service is unavailable.', 503);
        } finally {
            clearTimeout(timeout);
        }

        let body = null;
        try {
            body = await response.json();
        } catch (error) {
            body = {};
        }

        if (!response.ok) {
            throw this.createError(body.error || 'Media converter service failed.', response.status || 502);
        }

        return body;
    }

    static async startConverterJob(payload) {
        const body = await this.requestConverter('/jobs', {
            method: 'POST',
            body: payload,
            timeoutMs: 30000
        });

        if (!body.success || !body.jobId) {
            throw this.createError(body.error || 'Media converter did not create a job.', 502);
        }

        return body;
    }

    static async getConverterJob(converterJobId) {
        return await this.requestConverter(`/jobs/${converterJobId}`, {
            timeoutMs: 30000
        });
    }

    static async cancelConverterJob(converterJobId) {
        if (!converterJobId) {
            return false;
        }

        try {
            const result = await this.requestConverter(`/jobs/${converterJobId}`, {
                method: 'DELETE',
                timeoutMs: 30000
            });
            return !!result.success;
        } catch (error) {
            console.error('Failed to cancel converter job:', error.message);
            return false;
        }
    }

    static async callConverterJob(payload, hooks = {}) {
        const started = await this.startConverterJob(payload);
        const converterJobId = started.jobId;

        if (typeof hooks.onConverterJob === 'function') {
            hooks.onConverterJob(converterJobId);
        }

        while (true) {
            if (typeof hooks.isCancelled === 'function' && hooks.isCancelled()) {
                await this.cancelConverterJob(converterJobId);
                throw this.createCancelledError();
            }

            const status = await this.getConverterJob(converterJobId);
            const progress = Math.max(0, Math.min(100, Math.round(status.progress || 0)));

            if (typeof hooks.onProgress === 'function') {
                hooks.onProgress({
                    status: status.status || 'running',
                    stage: 'converting',
                    progress: Math.min(94, 5 + Math.round(progress * 0.89)),
                    converterProgress: progress,
                    converterJobId
                });
            }

            if (status.status === 'completed') {
                return {
                    success: true,
                    outputs: status.outputs || []
                };
            }

            if (status.status === 'cancelled') {
                throw this.createCancelledError();
            }

            if (status.status === 'failed') {
                throw this.createError(status.error || 'Media converter service failed.', 422);
            }

            await sleep(1000);
        }
    }

    static async saveGeneratedFile(outputPath, userId, target, filename, mimeOverride = null) {
        if (!await fs.pathExists(outputPath)) {
            throw this.createError('Media converter did not produce the expected output.', 500);
        }

        const safeName = this.sanitizeFilename(filename || path.basename(outputPath));
        let persistedPath = outputPath;

        if (!StorageService.isObjectStorage()) {
            persistedPath = path.join(FileService.uploadDirectory, target.relativeUploadDir, safeName);
            await fs.ensureDir(path.dirname(persistedPath));

            if (path.resolve(outputPath) !== path.resolve(persistedPath)) {
                await fs.copy(outputPath, persistedPath);
            }
        }

        const file = await FileService.saveFileMetadata(
            persistedPath,
            userId,
            safeName,
            target.parentId,
            target.relativeUploadDir
        );

        if (mimeOverride) {
            file.mimetype = mimeOverride;
            await file.save();
        }

        await FileService.recalculateFolderStats(target.parentId);

        return {
            id: file._id.toString(),
            name: file.name,
            path: file.path,
            mimetype: file.mimetype,
            size: file.size,
            scanStatus: file.scanStatus
        };
    }

    static async execute(userId, payload = {}, hooks = {}) {
        const { operation, sourceFile } = await this.validateRequest(userId, payload);
        const jobRoot = await this.createJobRoot(userId);
        const emitProgress = (progress) => {
            if (typeof hooks.onProgress === 'function') {
                hooks.onProgress(progress);
            }
        };
        const assertNotCancelled = async () => {
            if (typeof hooks.isCancelled === 'function' && hooks.isCancelled()) {
                if (typeof hooks.getConverterJobId === 'function') {
                    await this.cancelConverterJob(hooks.getConverterJobId());
                }
                throw this.createCancelledError();
            }
        };

        try {
            emitProgress({
                status: 'running',
                stage: 'preparing',
                progress: 1
            });
            await assertNotCancelled();

            const inputPath = await this.materializeToJob(sourceFile, jobRoot);
            const outputDir = path.join(jobRoot, 'output');
            await fs.ensureDir(outputDir);
            await assertNotCancelled();

            emitProgress({
                status: 'running',
                stage: 'converting',
                progress: 5
            });

            const converterResult = await this.callConverterJob({
                operation,
                inputPath: this.getRelativeToWorkRoot(inputPath),
                outputDir: this.getRelativeToWorkRoot(outputDir),
                outputFileName: payload.outputFileName,
                options: payload.options || {}
            }, hooks);
            await assertNotCancelled();

            const target = await this.getOutputTarget(userId, payload.parentId, sourceFile.parent_id);
            const files = [];

            emitProgress({
                status: 'saving',
                stage: 'saving',
                progress: 96
            });

            for (const output of converterResult.outputs || []) {
                const outputPath = path.join(config.mediaConversion.workRoot, output.path);
                files.push(await this.saveGeneratedFile(
                    outputPath,
                    userId,
                    target,
                    output.fileName,
                    output.mimeType
                ));
            }

            emitProgress({
                status: 'completed',
                stage: 'completed',
                progress: 100
            });

            return {
                success: true,
                message: `${files.length} media output${files.length === 1 ? '' : 's'} created successfully.`,
                files
            };
        } finally {
            await fs.remove(jobRoot);
        }
    }
}

module.exports = MediaConversionService;
