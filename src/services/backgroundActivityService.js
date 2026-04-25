const File = require('../models/fileModel');
const UploadProgress = require('../models/uplodPrgress');
const compressionQueue = require('../queues/compressionQueue');
const mediaConversionQueue = require('../queues/mediaConversionQueue');
const documentConversionQueue = require('../queues/documentConversionQueue');
const contentIntelligenceQueue = require('../queues/contentIntelligenceQueue');
const backgroundOperationRegistry = require('./backgroundOperationRegistry');
const ActivityEventService = require('./activityEventService');
const OrganizationShareService = require('./organizationShareService');

function calculateUploadProgress(upload) {
    const totalChunks = Number(upload.totalChunks) || 0;
    if (!totalChunks) {
        return 0;
    }

    return Math.round(((upload.uploadedChunks || []).length / totalChunks) * 100);
}

class BackgroundActivityService {
    static async getState(userId) {
        const [
            scans,
            uploads,
            compression,
            mediaConversions,
            documentConversions,
            contentIntelligence,
            events
        ] = await Promise.all([
            this.getActiveScans(userId),
            this.getInterruptedUploads(userId),
            compressionQueue.getActiveJobsForUser(userId),
            mediaConversionQueue.getActiveJobsForUser(userId),
            documentConversionQueue.getActiveJobsForUser(userId),
            contentIntelligenceQueue.getActiveJobsForUser(userId),
            ActivityEventService.list(userId)
        ]);

        return {
            success: true,
            scans,
            uploads,
            compression,
            mediaConversions,
            documentConversions,
            contentIntelligence,
            operations: backgroundOperationRegistry.list(userId),
            events
        };
    }

    static async getActiveScans(userId) {
        const activeScanFilter = {
            deleted: false,
            scanStatus: { $in: ['pending', 'scanning'] }
        };
        const [ownedFiles, accessibleShares] = await Promise.all([
            File.find({
                userId,
                ...activeScanFilter
            })
                .select('_id name path parent_id mimetype size scanStatus scanProgress scanResult createdAt updatedAt')
                .lean(),
            OrganizationShareService.getSharesForUser(userId, { itemType: 'file' }).catch(() => [])
        ]);
        const sharedFileIds = accessibleShares
            .filter(share => share.ownerId !== userId.toString())
            .map(share => share.itemId)
            .filter(Boolean);
        const sharedFiles = sharedFileIds.length
            ? await File.find({
                _id: { $in: sharedFileIds },
                ...activeScanFilter
            })
                .select('_id name path parent_id mimetype size scanStatus scanProgress scanResult createdAt updatedAt')
                .lean()
            : [];
        const filesById = {};

        ownedFiles.concat(sharedFiles).forEach(file => {
            filesById[file._id.toString()] = file;
        });

        return Object.values(filesById).map(file => ({
            fileId: file._id.toString(),
            fileName: file.name,
            filePath: file.path,
            parentId: file.parent_id || null,
            workspaceId: file.workspaceId || '',
            mimetype: file.mimetype || '',
            size: file.size || 0,
            status: file.scanStatus || 'pending',
            progress: file.scanProgress || 0,
            result: file.scanResult || null,
            createdAt: file.createdAt,
            updatedAt: file.updatedAt
        }));
    }

    static async getInterruptedUploads(userId) {
        const uploads = await UploadProgress.find({ userId })
            .select('_id filename folderId workspaceId fileSize totalChunks uploadedChunks createdAt')
            .sort({ createdAt: -1 })
            .lean();

        return uploads.map(upload => ({
            id: upload._id.toString(),
            filename: upload.filename,
            fileName: upload.filename,
            folderId: upload.folderId || '',
            workspaceId: upload.workspaceId || '',
            fileSize: upload.fileSize || 0,
            totalChunks: upload.totalChunks || 0,
            uploadedChunks: (upload.uploadedChunks || []).length,
            progress: calculateUploadProgress(upload),
            status: 'interrupted',
            createdAt: upload.createdAt
        }));
    }
}

module.exports = BackgroundActivityService;
