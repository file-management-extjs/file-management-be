const Queue = require('bull');
const File = require('../models/fileModel');
const VirusScanner = require('../services/virusScanner');
const fs = require('fs-extra');
const config = require('../config');
const FileService = require('../services/fileService');
const socket = require('../socket');
const { fileEvents, EVENT_TYPES } = require('../services/eventService');
const Share = require('../models/shareModel');

// Create scanning queue only if virus scanning is enabled
let scanningQueue = null;

if (config.virusScanning?.enabled) {
    scanningQueue = new Queue('virus-scanning', {
        redis: config.virusScanning.redis
    });

    const emitScanUpdate = function(io, userIds = [], payload = {}) {
        const recipients = [...new Set(
            (Array.isArray(userIds) ? userIds : [userIds])
                .filter(Boolean)
                .map(userId => userId.toString())
        )];

        recipients.forEach(userId => {
            io.to(userId).emit('fileScanUpdate', payload);
        });
    };

    const getScanRecipients = async function(file, baseUserIds = []) {
        const baseRecipients = (Array.isArray(baseUserIds) ? baseUserIds : [baseUserIds])
            .filter(Boolean)
            .map(userId => userId.toString());

        if (!file || !file._id) {
            return [...new Set(baseRecipients)];
        }

        const now = new Date();
        const directShares = await Share.find({
            itemId: file._id.toString(),
            itemType: 'file',
            revoked: false,
            approvalStatus: { $nin: ['pending', 'rejected'] },
            targetType: { $in: [null, 'member'] },
            $and: [
                {
                    $or: [
                        { expiresAt: null },
                        { expiresAt: { $gt: now } }
                    ]
                }
            ]
        }).select('recipientId').lean();

        return [...new Set(
            baseRecipients
                .concat(file.userId ? file.userId.toString() : [])
                .concat(directShares.map(share => share.recipientId).filter(Boolean))
        )];
    };

    const refreshFileStats = async function(file) {
        if (!file) {
            return;
        }

        const userId = file.userId ? file.userId.toString() : null;
        const parentId = file.parent_id ? file.parent_id.toString() : null;

        if (parentId) {
            await FileService.recalculateFolderStats(parentId);
        }

        if (userId) {
            fileEvents.emit(EVENT_TYPES.FILE_UPDATED, {
                userId,
                fileId: file._id ? file._id.toString() : null,
                parentId,
                scanStatus: file.scanStatus
            });
        }
    };

    // Process scanning jobs
    scanningQueue.process(async (job) => {
        const { fileId, ownerUserId, notifyUserIds = [] } = job.data;
        console.log(`Starting virus scan for file ${fileId}`);
        const io = socket.getIO();
        let recipients = [...new Set(
            [...notifyUserIds, ownerUserId]
                .filter(Boolean)
                .map(userId => userId.toString())
        )];

        try {
            // Get file document
            const file = await File.findById(fileId);
            if (!file) {
                throw new Error('File not found');
            }

            recipients = await getScanRecipients(file, recipients);

            // Update status to scanning
            file.scanStatus = 'scanning';
            file.scanProgress = 0;
            await file.save();
            
            // Emit initial progress
            emitScanUpdate(io, recipients, {
                fileId: file._id,
                fileName: file.name,
                filePath: file.path,
                parentId: file.parent_id,
                status: 'scanning',
                progress: 0
            });

            console.log(`Updated status to scanning for file ${fileId}`);

            // Scan the file
            const filePath = await FileService.materializeFile(file);
            console.log(`Scanning file at path: ${filePath}`);
            
            const result = await VirusScanner.scanFile(filePath);
            console.log(`Scan completed for file ${fileId}. Result:`, result);

            // Update file based on scan results
            file.scanStatus = result.isInfected ? 'infected' : 'clean';
            file.scanResult = result.viruses?.join(', ') || null;
            file.scanDate = new Date();
            file.scanProgress = 100;
            
            if (result.isInfected) {
                console.log(`Virus detected in file ${fileId}. Deleting file...`);
                // Delete infected file
                await FileService.deleteFile(file.userId.toString(), file._id);
                file.deleted = true;
            }

            if (filePath.includes(FileService.tempDirectory)) {
                await fs.remove(filePath);
            }

            await file.save();
            await refreshFileStats(file);

            // Emit final status
            recipients = await getScanRecipients(file, recipients);
            emitScanUpdate(io, recipients, {
                fileId: file._id,
                fileName: file.name,
                filePath: file.path,
                parentId: file.parent_id,
                status: file.scanStatus,
                progress: 100,
                result: file.scanResult
            });

            console.log(`Updated final scan status for file ${fileId}: ${file.scanStatus}`);

            return { success: true, fileId, scanStatus: file.scanStatus };
        } catch (error) {
            console.error(`Error scanning file ${fileId}:`, error);
            
            // Update file status on error
            if (fileId) {
                const file = await File.findById(fileId);
                if (file) {
                    recipients = await getScanRecipients(file, recipients);
                    file.scanStatus = 'infected'; // Treat errors as potential threats
                    file.scanResult = error.message;
                    file.scanDate = new Date();
                    file.scanProgress = 0;
                    await file.save();
                    await refreshFileStats(file);

                    // Emit error status
                    emitScanUpdate(io, recipients, {
                        fileId: file._id,
                        fileName: file.name,
                        filePath: file.path,
                        parentId: file.parent_id,
                        status: 'error',
                        error: error.message
                    });

                    console.log(`Updated error status for file ${fileId}`);
                }
            }
            
            throw error;
        }
    });

    // Handle completed jobs
    scanningQueue.on('completed', (job, result) => {
        console.log(`Scanning completed for file ${result.fileId}: ${result.scanStatus}`);
    });

    // Handle failed jobs
    scanningQueue.on('failed', (job, error) => {
        console.error(`Scanning failed for file ${job.data.fileId}:`, error);
    });
}

module.exports = scanningQueue;
