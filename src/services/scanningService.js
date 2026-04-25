const { fileEvents, EVENT_TYPES } = require('./eventService');
const scanningQueue = require('../queues/scanningQueue');
const config = require('../config');
const socket = require('../socket');
const File = require('../models/fileModel');
const FileService = require('./fileService');

class ScanningService {
    static isEnabled = false;
    static isInitialized = false;

    static serializeScanState(file, overrides = {}) {
        return {
            fileId: file._id.toString(),
            fileName: file.name,
            filePath: file.path,
            parentId: file.parent_id || null,
            workspaceId: file.workspaceId || null,
            mimetype: file.mimetype || '',
            size: file.size || 0,
            status: overrides.status || file.scanStatus || 'pending',
            progress: overrides.progress !== undefined ? overrides.progress : (file.scanProgress || 0),
            result: overrides.result !== undefined ? overrides.result : (file.scanResult || null)
        };
    }

    static normalizeUserIds(userIds = []) {
        return [...new Set(
            (Array.isArray(userIds) ? userIds : [userIds])
                .filter(Boolean)
                .map(userId => userId.toString())
        )];
    }

    static initialize() {
        // Only initialize once
        if (this.isInitialized) return;
        
        console.log('Initializing ScanningService...');
        console.log('Virus scanning enabled:', config.virusScanning?.enabled);

        // Only set up listeners if scanning is enabled
        if (config.virusScanning?.enabled) {
            this.isEnabled = true;
            this.setupListeners();
            this.enqueuePendingFiles().catch((error) => {
                console.error('Failed to enqueue pending virus scans:', error);
            });
            console.log('Virus scanning listeners set up successfully');
        }

        this.isInitialized = true;
    }

    static setupListeners() {
        console.log('Setting up file upload listeners for virus scanning...');
        
        fileEvents.on(EVENT_TYPES.FILE_UPLOADED, async (data) => {
            if (!this.isEnabled) return;

            const { fileId, userId, fileName, filePath, parentId, workspaceId } = data;
            console.log(`Queueing file ${fileId} for virus scanning...`);
            
            try {
                await this.queueFileScan(fileId, userId, {
                    notifyUserIds: [userId]
                });
                this.emitScanUpdate([userId], {
                    fileId,
                    fileName,
                    filePath,
                    parentId,
                    workspaceId,
                    status: 'pending',
                    progress: 0
                });
                console.log(`File ${fileId} queued for scanning successfully`);
            } catch (error) {
                console.error(`Error queueing file ${fileId} for scanning:`, error);
            }
        });
    }

    static emitScanUpdate(userIds = [], payload = {}) {
        const io = socket.getIO();
        const recipients = this.normalizeUserIds(userIds);

        recipients.forEach(userId => {
            io.to(userId).emit('fileScanUpdate', payload);
        });
    }

    static async queueFileScan(fileId, ownerUserId, options = {}) {
        if (!scanningQueue) {
            return;
        }

        await scanningQueue.add({
            fileId,
            ownerUserId,
            notifyUserIds: this.normalizeUserIds(options.notifyUserIds || [ownerUserId])
        }, {
            attempts: 3,
            backoff: {
                type: 'exponential',
                delay: 2000
            }
        });
    }

    static async ensureFileScanQueued(file, options = {}) {
        if (!file) {
            return {
                queued: false,
                status: null
            };
        }

        if (!this.isEnabled || !scanningQueue) {
            return {
                queued: false,
                status: file.scanStatus || 'clean'
            };
        }

        if (file.deleted) {
            return {
                queued: false,
                status: 'deleted'
            };
        }

        if (file.scanStatus === 'clean' || file.scanStatus === 'infected') {
            return {
                queued: false,
                ...this.serializeScanState(file, {
                    status: file.scanStatus,
                    progress: file.scanStatus === 'clean' ? 100 : (file.scanProgress || 0)
                })
            };
        }

        const ownerUserId = (options.ownerUserId || file.userId || '').toString();
        const notifyUserIds = this.normalizeUserIds(options.notifyUserIds || [ownerUserId]);

        if (['pending', 'scanning'].includes(file.scanStatus)) {
            const scanState = this.serializeScanState(file);
            this.emitScanUpdate(notifyUserIds, scanState);

            return {
                queued: false,
                ...scanState
            };
        }

        file.scanStatus = 'pending';
        file.scanProgress = 0;
        file.scanResult = null;
        await file.save();

        await this.queueFileScan(file._id.toString(), ownerUserId, {
            notifyUserIds
        });

        const scanState = this.serializeScanState(file, {
            status: 'pending',
            progress: 0,
            result: null
        });
        this.emitScanUpdate(notifyUserIds, scanState);

        return {
            queued: true,
            ...scanState
        };
    }

    static async requestFileScan(requestingUserId, fileId) {
        if (!this.isEnabled || !scanningQueue) {
            const error = new Error('Virus scanning is currently disabled.');
            error.statusCode = 503;
            throw error;
        }

        const file = await FileService.getAccessibleFileById(requestingUserId, fileId);
        if (!file) {
            const error = new Error('File not found or access denied.');
            error.statusCode = 404;
            throw error;
        }

        if (file.deleted) {
            const error = new Error('File is no longer available.');
            error.statusCode = 410;
            throw error;
        }

        if (['pending', 'scanning'].includes(file.scanStatus)) {
            const notifyUserIds = this.normalizeUserIds([requestingUserId, file.userId && file.userId.toString()]);
            const scanState = this.serializeScanState(file);
            this.emitScanUpdate(notifyUserIds, scanState);

            return {
                queued: false,
                ...scanState
            };
        }

        const notifyUserIds = [...new Set([requestingUserId, file.userId.toString()])];
        const result = await this.ensureFileScanQueued(file, {
            notifyUserIds
        });

        return {
            queued: !!result.queued,
            fileId: file._id.toString(),
            fileName: file.name,
            filePath: file.path,
            parentId: file.parent_id || null,
            workspaceId: file.workspaceId || null,
            mimetype: file.mimetype || '',
            size: file.size || 0,
            status: result.status || 'pending',
            progress: result.progress || 0,
            result: result.result || null
        };
    }

    static async enqueuePendingFiles() {
        if (!this.isEnabled || !scanningQueue) {
            return;
        }

        const pendingFiles = await File.find({
            deleted: false,
            scanStatus: { $in: ['pending', 'scanning'] }
        }).select('_id userId name path parent_id workspaceId').lean();

        for (const file of pendingFiles) {
            await this.queueFileScan(file._id, file.userId, {
                notifyUserIds: [file.userId]
            });
            this.emitScanUpdate([file.userId], {
                fileId: file._id,
                fileName: file.name,
                filePath: file.path,
                parentId: file.parent_id,
                workspaceId: file.workspaceId || null,
                status: 'pending',
                progress: 0
            });
        }

        if (pendingFiles.length > 0) {
            console.log(`Re-queued ${pendingFiles.length} pending virus scan(s).`);
        }
    }

    static enable() {
        if (!this.isInitialized) {
            this.initialize();
        }
        this.isEnabled = true;
        console.log('Virus scanning enabled');
    }

    static disable() {
        this.isEnabled = false;
        console.log('Virus scanning disabled');
    }
}

module.exports = ScanningService;
