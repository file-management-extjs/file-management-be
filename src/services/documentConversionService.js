const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const File = require('../models/fileModel');
const config = require('../config');
const FileService = require('./fileService');
const StorageService = require('./storage/storageService');
const {
    TARGET_FORMATS,
    createError,
    sanitizeFilename,
    convertEntryToTarget
} = require('./documentConversion/documentTools');
const {
    isConvertibleDocument,
    intersectAllowedTargetFormats,
    listTargetFormats
} = require('./documentConversion/documentFormats');

class DocumentConversionService {
    static supportedTargetFormats = Object.keys(TARGET_FORMATS);

    static createError(message, statusCode = 400) {
        return createError(message, statusCode);
    }

    static createCancelledError() {
        const error = this.createError('Document conversion cancelled.', 499);
        error.cancelled = true;
        return error;
    }

    static getTargetFormats() {
        return listTargetFormats();
    }

    static async getOwnedFiles(userId, fileIds) {
        const uniqueFileIds = Array.from(new Set((fileIds || []).filter(Boolean).map(String)));

        if (!uniqueFileIds.length) {
            throw this.createError('Select one or more files to convert.');
        }

        const files = await File.find({
            _id: { $in: uniqueFileIds },
            userId: userId.toString(),
            deleted: false
        });

        if (files.length !== uniqueFileIds.length) {
            throw this.createError('One or more files were not found or are not owned by you.', 403);
        }

        const fileById = files.reduce((result, file) => {
            result[file._id.toString()] = file;
            return result;
        }, {});

        return uniqueFileIds.map(fileId => fileById[fileId]);
    }

    static async validateRequest(userId, payload = {}) {
        const targetFormat = String(payload.targetFormat || '').toLowerCase();
        const files = await this.getOwnedFiles(userId, payload.fileIds);

        files.forEach(file => {
            FileService.assertPasswordAccess(file, userId);

            if (!isConvertibleDocument(file)) {
                throw this.createError(`"${file.name}" is not supported by Document Conversion Suite.`);
            }
        });

        const allowedTargetFormats = intersectAllowedTargetFormats(files);
        if (!allowedTargetFormats.length) {
            throw this.createError('The selected files do not share a common document conversion target.');
        }

        if (!allowedTargetFormats.includes(targetFormat)) {
            throw this.createError('Choose a supported target format for the selected files.');
        }

        return {
            files,
            targetFormat,
            allowedTargetFormats
        };
    }

    static async createJobRoot(userId) {
        const root = path.join(config.documentConversion.workRoot, 'jobs', userId.toString());
        await fs.ensureDir(root);
        return fs.mkdtemp(path.join(root, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-`));
    }

    static async materializeFiles(files, jobRoot) {
        const inputDir = path.join(jobRoot, 'input');
        await fs.ensureDir(inputDir);

        const usedNames = new Set();
        const materialized = [];

        for (const file of files) {
            let safeName = sanitizeFilename(file.name || file._id.toString());
            const extension = path.extname(safeName);
            const base = path.basename(safeName, extension);
            let counter = 1;

            while (usedNames.has(safeName.toLowerCase())) {
                safeName = `${base}-${counter}${extension}`;
                counter += 1;
            }

            usedNames.add(safeName.toLowerCase());

            const destinationPath = path.join(inputDir, safeName);
            const materializedPath = await StorageService.materializeFile(file, destinationPath);

            if (materializedPath !== destinationPath) {
                await fs.copy(materializedPath, destinationPath);
            }

            materialized.push({
                file,
                sourcePath: destinationPath,
                safeName
            });
        }

        return materialized;
    }

    static async getOutputTarget(userId, parentId, fallbackParentId = null) {
        const normalizedParentId = parentId === undefined ? fallbackParentId : parentId || null;
        const relativeUploadDir = await FileService.getRelativeUploadDir(userId, normalizedParentId);

        return {
            parentId: normalizedParentId,
            relativeUploadDir
        };
    }

    static async saveGeneratedFile(outputPath, userId, target, filename, mimeOverride = null) {
        if (!await fs.pathExists(outputPath)) {
            throw this.createError('Document conversion did not create the expected output.', 500);
        }

        const safeName = sanitizeFilename(filename || path.basename(outputPath));
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

    static buildBatchLabel(files, targetFormat) {
        if (!Array.isArray(files) || !files.length) {
            return 'Document conversion';
        }

        if (files.length === 1) {
            return files[0].name;
        }

        const targetLabel = TARGET_FORMATS[targetFormat] ? TARGET_FORMATS[targetFormat].label : targetFormat.toUpperCase();
        return `${files.length} files to ${targetLabel}`;
    }

    static emitProgress(hooks, patch = {}) {
        if (typeof hooks.onProgress !== 'function') {
            return;
        }

        hooks.onProgress(patch);
    }

    static assertNotCancelled(hooks = {}) {
        if (typeof hooks.isCancelled === 'function' && hooks.isCancelled()) {
            throw this.createCancelledError();
        }
    }

    static async execute(userId, payload = {}, hooks = {}) {
        const { files, targetFormat } = await this.validateRequest(userId, payload);
        const jobRoot = await this.createJobRoot(userId);
        const outputDir = path.join(jobRoot, 'output');
        const outputs = [];

        try {
            this.emitProgress(hooks, {
                status: 'running',
                stage: 'preparing',
                progress: 2
            });

            await fs.ensureDir(outputDir);
            this.assertNotCancelled(hooks);

            const materializedFiles = await this.materializeFiles(files, jobRoot);
            const target = await this.getOutputTarget(userId, payload.parentId, files[0] ? files[0].parent_id : null);
            const totalFiles = materializedFiles.length;

            for (let index = 0; index < materializedFiles.length; index += 1) {
                const entry = materializedFiles[index];
                const progressStart = Math.round(5 + ((index / totalFiles) * 88));

                this.emitProgress(hooks, {
                    status: 'running',
                    stage: 'converting',
                    progress: progressStart,
                    currentFileName: entry.file.name,
                    message: `Converting ${entry.file.name}`
                });

                this.assertNotCancelled(hooks);

                const converted = await convertEntryToTarget(entry, targetFormat, {
                    workRoot: path.join(jobRoot, `work-${index + 1}`),
                    outputDir,
                    requestedOutputName: payload.outputFileName || '',
                    options: payload.options || {},
                    index,
                    total: totalFiles,
                    processTracker: hooks.processTracker,
                    isCancelled: hooks.isCancelled,
                    timeoutMs: config.documentConversion.commandTimeoutMs,
                    previewDpi: payload.options && payload.options.previewDpi
                });

                this.assertNotCancelled(hooks);

                outputs.push(await this.saveGeneratedFile(
                    converted.path,
                    userId,
                    target,
                    converted.fileName,
                    converted.mimeType
                ));

                this.emitProgress(hooks, {
                    status: 'running',
                    stage: 'saving',
                    progress: Math.round(5 + (((index + 1) / totalFiles) * 90)),
                    currentFileName: entry.file.name
                });
            }

            this.emitProgress(hooks, {
                status: 'completed',
                stage: 'completed',
                progress: 100
            });

            return {
                success: true,
                message: `${outputs.length} converted document${outputs.length === 1 ? '' : 's'} created successfully.`,
                files: outputs
            };
        } finally {
            await fs.remove(jobRoot);
        }
    }
}

module.exports = DocumentConversionService;
