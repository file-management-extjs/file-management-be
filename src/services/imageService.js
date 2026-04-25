const sharp = require('sharp');
const path = require('path');
const File = require('../models/fileModel');
const mime = require('mime');
const fs = require('fs-extra');
const FileService = require('./fileService');
const StorageService = require('./storage/storageService');
const config = require('../config');

class ImageService {
    static uploadDirectory = config.storage.localRoot;

    static createError(message, statusCode) {
        const error = new Error(message);
        error.statusCode = statusCode;
        return error;
    }

    static async convertImage(userId, fileId, targetFormat, quality = 100) {
        const accessibleFile = await FileService.getAccessibleFileById(userId, fileId);

        if (!accessibleFile) {
            throw this.createError('Source file not found.', 404);
        }

        if (accessibleFile.userId.toString() !== userId.toString()) {
            throw this.createError('Only the owner can convert this image.', 403);
        }

        const originalFile = accessibleFile;
        FileService.assertPasswordAccess(originalFile, userId);

        targetFormat = targetFormat.toLowerCase();

        if (!['png', 'jpg', 'jpeg', 'webp', 'avif'].includes(targetFormat)) {
            throw this.createError('Invalid target format.', 400);
        }

        const sourceMimeType = originalFile.mimetype || mime.getType(originalFile.name) || '';
        if (!sourceMimeType.startsWith('image/')) {
            throw this.createError('Source file is not an image.', 400);
        }

        const outputFileName = `${path.basename(originalFile.name, path.extname(originalFile.name))}-converted-${Date.now()}.${targetFormat}`;
        const outputFilePath = path.join(path.dirname(originalFile.path), outputFileName);
        const absoluteInputFilePath = StorageService.isObjectStorage()
            ? await FileService.materializeFile(originalFile)
            : path.join(this.uploadDirectory, originalFile.path);
        const absoluteOutputFilePath = StorageService.isObjectStorage()
            ? FileService.getTempPath('image-conversions', originalFile.userId.toString(), outputFileName)
            : path.join(this.uploadDirectory, outputFilePath);

        if (!fs.existsSync(absoluteInputFilePath)) {
            throw this.createError('File not found.', 404);
        }

        try {
            await fs.ensureDir(path.dirname(absoluteOutputFilePath));

            // Perform the image conversion
            await sharp(absoluteInputFilePath)
                .toFormat(targetFormat, { quality: parseInt(quality) || 100 })
                .toFile(absoluteOutputFilePath);

            const fileStats = fs.statSync(absoluteOutputFilePath);
            const mimeType = mime.getType(absoluteOutputFilePath);

            const newFile = await FileService.saveFileMetadata(
                absoluteOutputFilePath,
                originalFile.userId,
                outputFileName,
                originalFile.parent_id,
                path.dirname(outputFilePath)
            );
            newFile.mimetype = mimeType;
            newFile.size = fileStats.size;
            await newFile.save();
            await FileService.recalculateFolderStats(originalFile.parent_id);

            if (StorageService.isObjectStorage()) {
                await fs.remove(absoluteInputFilePath);
            }

            return {
                message: 'Image converted successfully.',
                fileId: newFile._id.toString(),
                fileName: newFile.name,
                scanStatus: newFile.scanStatus,
                filePath: newFile.path
            };
        } catch (error) {
            console.error('Image conversion failed:', error);
            if (error.statusCode) {
                throw error;
            }

            throw this.createError('Image conversion failed.', 500);
        }
    }
}

module.exports = ImageService;
