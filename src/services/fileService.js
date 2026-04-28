const File = require('../models/fileModel');
const Folder = require('../models/folderModel');
const UploadProgress = require('../models/uplodPrgress');
const Share = require('../models/shareModel');
const ShareLink = require('../models/shareLinkModel');
const User = require('../models/userModel');
const fs = require('fs-extra');
const path = require('path');
const mime = require('mime');
const archiver = require('archiver');
const extract = require('extract-zip');
const { AbortController } = require('abort-controller');
const AdmZip = require('adm-zip');
const bcrypt = require('bcrypt');
const CompressionService = require('./compressionService');
const socket = require('../socket');
const { fileEvents, EVENT_TYPES } = require('./eventService');
const config = require('../config'); // Import config
const { ACCESS_VERIFICATION_WINDOW_MS } = require('../constants/access');
const StorageService = require('./storage/storageService');
const SearchService = require('./searchService');
const StorageInsightsService = require('./storageInsightsService');
const OrganizationShareService = require('./organizationShareService');
const ActivityEventService = require('./activityEventService');
const WorkspaceService = require('./workspaceService');

class FileService {
    static uploadDirectory = config.storage.localRoot;
    static tempDirectory = config.storage.tempRoot;
    static ongoingCompressions = new Map();
    static privateVaultFolderName = 'Private Vault';
    static privateVaultStorageDir = '.private-vault';

    static async resolveWorkspaceContext(userId, workspaceId = null, options = {}) {
        return WorkspaceService.assertWorkspaceAccess(userId, workspaceId, options);
    }

    static async getWorkspaceContextFromOptions(userId, options = {}) {
        if (options.workspaceContext && options.workspaceContext.workspace) {
            return options.workspaceContext;
        }

        return this.resolveWorkspaceContext(userId, options.workspaceId || null, options);
    }

    static getWorkspaceContextFromItem(item) {
        return {
            workspace: {
                _id: item.workspaceId || null,
                type: item.workspaceType || 'personal',
                organizationId: item.organizationId || null
            }
        };
    }

    static getWorkspaceItemPatch(workspaceContext, userId) {
        return WorkspaceService.getWorkspacePatch(workspaceContext.workspace, userId);
    }

    static getScopedItemQuery(workspaceContext, extra = {}) {
        return WorkspaceService.getItemScopeQuery(workspaceContext.workspace, extra);
    }

    static getAncestorScope(item, workspaceContext = null) {
        const workspaceId = workspaceContext && workspaceContext.workspace
            ? workspaceContext.workspace._id
            : item && item.workspaceId;

        if (workspaceId) {
            return { workspaceId: workspaceId.toString() };
        }

        return { userId: item && item.userId ? item.userId.toString() : '' };
    }

    static getStorageInsightKey(workspaceContext, userId) {
        return workspaceContext && workspaceContext.workspace && workspaceContext.workspace._id
            ? workspaceContext.workspace._id.toString()
            : userId;
    }

    static createServiceError(message, statusCode = 400) {
        const error = new Error(message);
        error.statusCode = statusCode;
        return error;
    }

    static escapeRegExp(value) {
        return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    static hasValidRecentAccess(item, userId) {
        const userAccess = (item.userAccess || []).find(
            access => access.userId === userId.toString()
        );

        const lastAccessed = userAccess ? new Date(userAccess.lastAccessed) : null;
        return !!lastAccessed && (Date.now() - lastAccessed.getTime()) <= ACCESS_VERIFICATION_WINDOW_MS;
    }

    static assertPasswordAccess(item, userId) {
        if (item.isPasswordProtected && !this.hasValidRecentAccess(item, userId)) {
            throw this.createServiceError('Password verification required', 401);
        }
    }

    static grantPasswordAccess(item, userId) {
        const normalizedUserId = userId.toString();
        const userAccessIndex = (item.userAccess || []).findIndex(
            access => access.userId === normalizedUserId
        );

        if (userAccessIndex >= 0) {
            item.userAccess[userAccessIndex].lastAccessed = new Date();
        } else {
            item.userAccess.push({
                userId: normalizedUserId,
                lastAccessed: new Date()
            });
        }
    }

    static assertPersonalWorkspaceContext(workspaceContext) {
        if (!workspaceContext || !workspaceContext.workspace || workspaceContext.workspace.type !== 'personal') {
            throw this.createServiceError('Private Vault is available only in personal workspaces.', 403);
        }
    }

    static getPrivateVaultFolderPath(workspaceContext) {
        return path.join(workspaceContext.workspace.rootPath, this.privateVaultStorageDir);
    }

    static async findPrivateVaultRoot(userId, workspaceContext, options = {}) {
        const query = {
            userId: userId.toString(),
            workspaceId: workspaceContext.workspace._id.toString(),
            isPrivateVaultRoot: true,
            deleted: false
        };
        const request = Folder.findOne(query);

        return options.includePassword === true ? request.select('+password') : request;
    }

    static serializePrivateVaultStatus(vaultRoot, userId, workspaceContext) {
        return {
            available: true,
            workspaceId: workspaceContext.workspace._id.toString(),
            workspaceType: workspaceContext.workspace.type,
            exists: !!vaultRoot,
            rootFolderId: vaultRoot ? vaultRoot._id.toString() : null,
            name: this.privateVaultFolderName,
            locked: vaultRoot ? !this.hasValidRecentAccess(vaultRoot, userId) : true
        };
    }

    static async getPrivateVaultStatus(userId, options = {}) {
        const workspaceContext = await this.getWorkspaceContextFromOptions(userId, options);
        this.assertPersonalWorkspaceContext(workspaceContext);

        const vaultRoot = await this.findPrivateVaultRoot(userId, workspaceContext);
        return this.serializePrivateVaultStatus(vaultRoot, userId, workspaceContext);
    }

    static async setupPrivateVault(userId, password, options = {}) {
        if (!password || String(password).length < 6) {
            throw this.createServiceError('Private Vault password must be at least 6 characters long.', 400);
        }

        const workspaceContext = await this.getWorkspaceContextFromOptions(userId, {
            ...options,
            requireWrite: true
        });
        this.assertPersonalWorkspaceContext(workspaceContext);

        const existingVault = await this.findPrivateVaultRoot(userId, workspaceContext);
        if (existingVault) {
            return this.serializePrivateVaultStatus(existingVault, userId, workspaceContext);
        }

        const vaultPath = this.getPrivateVaultFolderPath(workspaceContext);
        if (!StorageService.isObjectStorage()) {
            await fs.ensureDir(path.join(this.uploadDirectory, vaultPath));
        }

        const workspacePatch = this.getWorkspaceItemPatch(workspaceContext, userId);
        const vaultRoot = new Folder({
            userId,
            ...workspacePatch,
            parent_id: null,
            name: this.privateVaultFolderName,
            path: vaultPath,
            isPrivateVaultRoot: true,
            isPasswordProtected: true,
            password: await bcrypt.hash(password, 10),
            userAccess: [{
                userId: userId.toString(),
                lastAccessed: new Date()
            }],
            createdAt: new Date()
        });

        await vaultRoot.save();
        StorageInsightsService.invalidateUser(this.getStorageInsightKey(workspaceContext, userId));

        return this.serializePrivateVaultStatus(vaultRoot, userId, workspaceContext);
    }

    static async unlockPrivateVault(userId, password, options = {}) {
        if (!password) {
            throw this.createServiceError('Password is required.', 400);
        }

        const workspaceContext = await this.getWorkspaceContextFromOptions(userId, options);
        this.assertPersonalWorkspaceContext(workspaceContext);

        const vaultRoot = await this.findPrivateVaultRoot(userId, workspaceContext, { includePassword: true });
        if (!vaultRoot) {
            throw this.createServiceError('Private Vault has not been created yet.', 404);
        }

        const isValid = await bcrypt.compare(password, vaultRoot.password || '');
        if (!isValid) {
            throw this.createServiceError('Invalid password', 401);
        }

        this.grantPasswordAccess(vaultRoot, userId);
        await vaultRoot.save();

        return this.serializePrivateVaultStatus(vaultRoot, userId, workspaceContext);
    }

    static async assertUnlockedItemAndAncestors(userId, item, workspaceContext, options = {}) {
        if (!item) {
            return;
        }

        if (options.includeItem !== false) {
            this.assertPasswordAccess(item, userId);
        }

        const scopedQuery = this.getAncestorScope(item, workspaceContext);
        let currentFolderId = options.parentId !== undefined ? options.parentId : item.parent_id;

        while (currentFolderId) {
            const folder = await Folder.findOne({
                _id: currentFolderId,
                ...scopedQuery,
                deleted: false
            });

            if (!folder) {
                break;
            }

            this.assertPasswordAccess(folder, userId);
            currentFolderId = folder.parent_id;
        }
    }

    static async assertUnlockedFolderPath(userId, folderId, workspaceContext) {
        const normalizedFolderId = this.normalizeFolderId(folderId);
        if (!normalizedFolderId || normalizedFolderId === 'root') {
            return null;
        }

        const folder = await Folder.findOne({
            _id: normalizedFolderId,
            ...this.getScopedItemQuery(workspaceContext),
            deleted: false
        });

        if (!folder) {
            throw this.createServiceError('Folder not found or access denied', 404);
        }

        await this.assertUnlockedItemAndAncestors(userId, folder, workspaceContext);
        return folder;
    }

    static async isInsidePrivateVault(item, workspaceContext) {
        if (!item) {
            return false;
        }

        if (item.isPrivateVaultRoot === true) {
            return true;
        }

        const scopedQuery = this.getAncestorScope(item, workspaceContext);
        let currentFolderId = item.parent_id;

        while (currentFolderId) {
            const folder = await Folder.findOne({
                _id: currentFolderId,
                ...scopedQuery,
                deleted: false
            }).select('_id parent_id isPrivateVaultRoot').lean();

            if (!folder) {
                return false;
            }

            if (folder.isPrivateVaultRoot === true) {
                return true;
            }

            currentFolderId = folder.parent_id;
        }

        return false;
    }

    static assertNotPrivateVaultRoot(item, action = 'modified') {
        if (item && item.isPrivateVaultRoot === true) {
            throw this.createServiceError(`Private Vault root cannot be ${action}.`, 403);
        }
    }

    static async assertNotInsidePrivateVault(item, workspaceContext, message = 'Private Vault items cannot be shared.') {
        if (await this.isInsidePrivateVault(item, workspaceContext)) {
            throw this.createServiceError(message, 403);
        }
    }

    static async assertFilesListAccess(userId, parentId = null, options = {}) {
        if (options.sharedByMe || !parentId) {
            return;
        }

        if (options.shared) {
            const parentFolder = await this.getAccessibleFolderById(userId, parentId);
            if (!parentFolder) {
                throw this.createServiceError('Shared folder not found or access denied', 404);
            }

            this.assertPasswordAccess(parentFolder, userId);
            return;
        }

        const workspaceContext = await this.getWorkspaceContextFromOptions(userId, options);
        await this.assertUnlockedFolderPath(userId, parentId, workspaceContext);
    }

    static getActiveShareFilter(recipientId, extra = {}) {
        return {
            recipientId: recipientId.toString(),
            revoked: false,
            approvalStatus: { $nin: ['pending', 'rejected'] },
            $and: [
                {
                    $or: [
                        { expiresAt: null },
                        { expiresAt: { $gt: new Date() } }
                    ]
                }
            ],
            ...extra
        };
    }

    static getPersonalShareScopeFilter() {
        return {
            $or: [
                { organizationId: null },
                { organizationId: '' },
                { organizationId: { $exists: false } }
            ]
        };
    }

    static getActiveOutgoingShareFilter(ownerId, extra = {}) {
        return {
            ownerId: ownerId.toString(),
            revoked: false,
            $and: [
                {
                    $or: [
                        { expiresAt: null },
                        { expiresAt: { $gt: new Date() } }
                    ]
                }
            ],
            ...extra
        };
    }

    static getOutgoingShareManagementFilter(ownerId, extra = {}) {
        return {
            ownerId: ownerId.toString(),
            revoked: false,
            ...extra
        };
    }

    static getActiveShareLinkFilter(ownerId, extra = {}) {
        return {
            ownerId: ownerId.toString(),
            revoked: false,
            $and: [
                {
                    $or: [
                        { expiresAt: null },
                        { expiresAt: { $gt: new Date() } }
                    ]
                }
            ],
            ...extra
        };
    }

    static getShareLinkManagementFilter(ownerId, extra = {}) {
        return {
            ownerId: ownerId.toString(),
            revoked: false,
            ...extra
        };
    }

    static getExpiryDate(expiryOptions = {}) {
        const options = typeof expiryOptions === 'object'
            ? expiryOptions
            : { expiresInHours: expiryOptions };
        const minutes = Number(options.expiresInMinutes);

        if (Number.isFinite(minutes) && minutes > 0) {
            return new Date(Date.now() + Math.min(minutes, 365 * 24 * 60) * 60 * 1000);
        }

        const expiresInHours = options.expiresInHours;
        const hours = Number(expiresInHours);

        if (!Number.isFinite(hours) || hours <= 0) {
            return null;
        }

        return new Date(Date.now() + Math.min(hours, 24 * 365) * 60 * 60 * 1000);
    }

    static async hasDirectShare(userId, itemId, itemType) {
        return !!await Share.findOne(this.getActiveShareFilter(userId, {
            itemId: itemId.toString(),
            itemType
        })).lean();
    }

    static async getDirectShare(userId, itemId, itemType) {
        return Share.findOne(this.getActiveShareFilter(userId, {
            itemId: itemId.toString(),
            itemType,
            ...this.getPersonalShareScopeFilter()
        })).lean();
    }

    static async getSharedAncestorShare(userId, item) {
        let currentFolderId = item.parent_id;

        while (currentFolderId) {
            const folder = await Folder.findOne({ _id: currentFolderId, deleted: false })
                .select('_id parent_id')
                .lean();

            if (!folder) {
                return false;
            }

            const share = await this.getDirectShare(userId, folder._id, 'folder');
            if (share) {
                return share;
            }

            currentFolderId = folder.parent_id;
        }

        return null;
    }

    static async hasSharedAncestor(userId, item) {
        return !!await this.getSharedAncestorShare(userId, item) ||
            !!await OrganizationShareService.getSharedAncestorShare(userId, item);
    }

    static async getAccessShare(userId, item, itemType) {
        const directShare = await this.getDirectShare(userId, item._id, itemType);
        return directShare ||
            await OrganizationShareService.getAccessShareForItem(userId, item, itemType) ||
            await this.getSharedAncestorShare(userId, item);
    }

    static async canAccessFile(userId, file) {
        if (!file || file.deleted) {
            return false;
        }

        if (file.userId.toString() === userId.toString()) {
            return true;
        }

        if (file.workspaceType === 'organization' && file.organizationId) {
            const membership = await WorkspaceService.getOrganizationMembership(userId, file.organizationId);
            if (membership) {
                return true;
            }
        }

        return !!await this.getAccessShare(userId, file, 'file');
    }

    static async canDownloadFile(userId, file) {
        if (!file || file.deleted) {
            return false;
        }

        if (file.userId.toString() === userId.toString()) {
            return true;
        }

        if (file.workspaceType === 'organization' && file.organizationId) {
            const membership = await WorkspaceService.getOrganizationMembership(userId, file.organizationId);
            if (membership) {
                return true;
            }
        }

        const share = await this.getAccessShare(userId, file, 'file');
        return OrganizationShareService.shareAllowsPermission(share, 'download');
    }

    static async recordDownloadAccess(userId, file) {
        if (!file || file.deleted || file.userId.toString() === userId.toString()) {
            return null;
        }

        if (file.workspaceType === 'organization' && file.organizationId) {
            const membership = await WorkspaceService.getOrganizationMembership(userId, file.organizationId);
            if (membership) {
                return null;
            }
        }

        const share = await this.getAccessShare(userId, file, 'file');
        if (!share) {
            return null;
        }

        if (!OrganizationShareService.shareAllowsPermission(share, 'download')) {
            throw this.createServiceError('Download access denied', 403);
        }

        return OrganizationShareService.recordDownloadAccess(share);
    }

    static async canAccessFolder(userId, folder) {
        if (!folder || folder.deleted) {
            return false;
        }

        if (folder.userId.toString() === userId.toString()) {
            return true;
        }

        if (folder.workspaceType === 'organization' && folder.organizationId) {
            const membership = await WorkspaceService.getOrganizationMembership(userId, folder.organizationId);
            if (membership) {
                return true;
            }
        }

        return !!await this.getAccessShare(userId, folder, 'folder');
    }

    static async getAccessibleFileById(userId, fileId) {
        const file = await File.findOne({ _id: fileId, deleted: false });
        return await this.canAccessFile(userId, file) ? file : null;
    }

    static async getAccessibleFolderById(userId, folderId) {
        const folder = await Folder.findOne({ _id: folderId, deleted: false });
        return await this.canAccessFolder(userId, folder) ? folder : null;
    }

    static async decorateSharedItem(item, recipientId, itemType = null) {
        const isOwner = item.userId.toString() === recipientId.toString();
        if (isOwner) {
            return { isShared: false };
        }

        const owner = await User.findById(item.userId).select('username email').lean();
        const share = itemType ? await this.getAccessShare(recipientId, item, itemType) : null;

        return {
            isShared: true,
            ownerId: item.userId.toString(),
            sharedBy: owner ? owner.username : 'Unknown user',
            permission: share ? share.permission : undefined,
            shareId: share ? share._id.toString() : undefined
        };
    }

    static async decorateOutgoingShareItem(item, viewerId, itemType) {
        if (!itemType || item.userId.toString() !== viewerId.toString()) {
            return {};
        }

        const [shares, publicLinks] = await Promise.all([
            Share.find(this.getActiveOutgoingShareFilter(viewerId, {
                itemId: item._id.toString(),
                itemType
            })).sort({ updatedAt: -1 }).lean(),
            ShareLink.find(this.getActiveShareLinkFilter(viewerId, {
                itemId: item._id.toString(),
                itemType
            })).sort({ updatedAt: -1 }).lean()
        ]);

        if (!shares.length && !publicLinks.length) {
            return {
                isSharedByMe: false,
                shareCount: 0,
                outgoingShareIds: [],
                publicLinkIds: []
            };
        }

        const recipientIds = shares
            .filter(share => !share.targetType || share.targetType === 'member')
            .map(share => share.recipientId);
        const recipients = await User.find({ _id: { $in: recipientIds } }).select('_id username email').lean();
        const recipientById = recipients.reduce((result, recipient) => {
            result[recipient._id.toString()] = recipient;
            return result;
        }, {});
        const recipientNames = shares.map(share => {
            if (share.targetLabel) {
                return share.targetLabel;
            }

            if (share.targetType === 'team') {
                return 'Team share';
            }

            if (share.targetType === 'organization') {
                return 'Organization share';
            }

            if (share.targetType === 'external') {
                return share.recipientId;
            }

            const recipient = recipientById[share.recipientId];
            return recipient ? recipient.username : 'Unknown user';
        });
        const targetNames = recipientNames.concat(publicLinks.length ? ['Anyone with link'] : []);
        const sharedWith = targetNames.length === 1
            ? targetNames[0]
            : `${targetNames[0]} + ${targetNames.length - 1} more`;

        return {
            isSharedByMe: true,
            shareCount: shares.length + publicLinks.length,
            outgoingShareIds: shares.map(share => share._id.toString()),
            hasPublicLink: publicLinks.length > 0,
            publicLinkCount: publicLinks.length,
            publicLinkIds: publicLinks.map(link => link._id.toString()),
            sharedWith,
            sharedWithList: targetNames.join(', ')
        };
    }

    static async prepareSharedFileForRecipient(file, recipientId) {
        if (!file || file.deleted) {
            return null;
        }

        if (file.scanStatus === 'infected') {
            return null;
        }

        if (file.userId.toString() === recipientId.toString() ||
            !config.virusScanning?.enabled ||
            file.scanStatus === 'clean') {
            return file;
        }

        const ScanningService = require('./scanningService');
        await ScanningService.ensureFileScanQueued(file, {
            notifyUserIds: [file.userId.toString(), recipientId.toString()]
        });

        return null;
    }

    static async assertSharedFileReadyForAccess(file, requesterId) {
        if (!file) {
            return;
        }

        if (file.userId.toString() === requesterId.toString()) {
            return;
        }

        if (file.scanStatus === 'infected') {
            throw this.createServiceError('This shared file failed virus scanning and is not available.', 410);
        }

        if (!config.virusScanning?.enabled || file.scanStatus === 'clean') {
            return;
        }

        const ScanningService = require('./scanningService');
        await ScanningService.ensureFileScanQueued(file, {
            notifyUserIds: [file.userId.toString(), requesterId.toString()]
        });

        throw this.createServiceError('This shared file is being scanned for viruses. Please try again after the scan completes.', 409);
    }

    static getFileCategory(mimetype = '') {
        const normalizedType = String(mimetype || '');

        if (!normalizedType) return 'Other';
        if (normalizedType.startsWith('image/')) return 'Images';
        if (normalizedType.startsWith('video/')) return 'Videos';
        if (normalizedType.startsWith('audio/')) return 'Audio';
        if (normalizedType.startsWith('text/')) return 'Text';
        if (normalizedType === 'application/pdf') return 'Documents';
        if (normalizedType.includes('word') || normalizedType.includes('excel') || normalizedType.includes('powerpoint')) return 'Documents';
        if (normalizedType.includes('spreadsheet') || normalizedType.includes('presentation')) return 'Documents';
        if (normalizedType.includes('zip') || normalizedType.includes('rar') || normalizedType.includes('7z') || normalizedType.includes('tar')) return 'Archives';
        return 'Other';
    }

    static getFileCategoryIcon(category) {
        const icons = {
            Images: 'fa fa-image green-icon',
            Videos: 'fa fa-film blue-icon',
            Audio: 'fa fa-music blue-icon',
            Text: 'fa fa-file-lines',
            Documents: 'fa fa-file-pdf red-icon',
            Archives: 'fa fa-file-archive yellow-icon',
            Other: 'fa fa-file'
        };

        return icons[category] || icons.Other;
    }

    static async buildFolderAncestors(userId, folderId, options = {}) {
        const ancestors = [];
        let currentFolderId = folderId;
        const workspaceContext = await this.getWorkspaceContextFromOptions(userId, options).catch(() => null);
        const workspaceId = workspaceContext && workspaceContext.workspace
            ? workspaceContext.workspace._id.toString()
            : null;

        while (currentFolderId) {
            const query = {
                _id: currentFolderId,
                deleted: false
            };

            if (workspaceId) {
                query.workspaceId = workspaceId;
            } else {
                query.userId = userId;
            }

            const folder = await Folder.findOne(query)
                .select('_id name parent_id')
                .lean();

            if (!folder) {
                break;
            }

            ancestors.unshift({
                id: folder._id.toString(),
                name: folder.name
            });

            currentFolderId = folder.parent_id;
        }

        return ancestors;
    }

    static async buildFolderAncestorsFromItemScope(item, folderId) {
        const ancestors = [];
        let currentFolderId = folderId;
        const scope = item && item.workspaceId
            ? { workspaceId: item.workspaceId }
            : { userId: item.userId ? item.userId.toString() : '' };

        while (currentFolderId) {
            const folder = await Folder.findOne({
                _id: currentFolderId,
                ...scope,
                deleted: false
            }).select('_id name parent_id').lean();

            if (!folder) {
                break;
            }

            ancestors.unshift({
                id: folder._id.toString(),
                name: folder.name
            });

            currentFolderId = folder.parent_id;
        }

        return ancestors;
    }

    static normalizeFolderId(folderId) {
        return folderId || null;
    }

    static getUploadProgressFilter(userId, filename, folderId = null, workspaceContext = null) {
        return {
            userId,
            ...(workspaceContext && workspaceContext.workspace ? {
                workspaceId: workspaceContext.workspace._id.toString()
            } : {}),
            filename,
            folderId: this.normalizeFolderId(folderId)
        };
    }

    static getChunkDir(uploadDir, fileName) {
        return path.join(uploadDir, '.chunks', encodeURIComponent(fileName));
    }

    static getChunkNumbers(chunkDir) {
        if (!fs.existsSync(chunkDir)) {
            return [];
        }

        return fs.readdirSync(chunkDir)
            .map((entry) => {
                const match = entry.match(/^chunk_(\d+)$/);
                return match ? parseInt(match[1], 10) : null;
            })
            .filter((chunkNumber) => Number.isInteger(chunkNumber))
            .sort((a, b) => a - b);
    }

    static getStorageKey(file) {
        return StorageService.getFileKey(file);
    }

    static getLogicalFilePath(userId, relativeUploadDir, filename) {
        return path.join(relativeUploadDir || userId, filename);
    }

    static async getFileStream(fileOrPath, options = {}) {
        try {
            if (typeof fileOrPath === 'string') {
                await fs.access(fileOrPath);

                return {
                    stream: fs.createReadStream(fileOrPath, options),
                    mimetype: mime.getType(fileOrPath)
                };
            }

            const stream = await StorageService.createReadStream(fileOrPath, options);
            return {
                stream,
                mimetype: fileOrPath.mimetype || mime.getType(fileOrPath.name)
            };
        } catch (error) {
            throw new Error('File not found or inaccessible');
        }
    }

    static async getStoredFileSize(file) {
        const stats = await StorageService.statFile(file);
        return stats.size;
    }

    static getTempPath(...parts) {
        return path.join(this.tempDirectory, ...parts);
    }

    static async materializeFile(file, filename = null) {
        const safeName = filename || file.name || path.basename(file.path);
        const tempPath = this.getTempPath(
            'materialized',
            file.userId.toString(),
            file._id.toString(),
            safeName
        );

        return StorageService.materializeFile(file, tempPath);
    }

    static async materializeFolder(folder, destinationPath) {
        await fs.ensureDir(destinationPath);

        const [files, subfolders] = await Promise.all([
            File.find({
                parent_id: folder._id.toString(),
                workspaceId: folder.workspaceId || null,
                deleted: false
            }),
            Folder.find({
                parent_id: folder._id.toString(),
                workspaceId: folder.workspaceId || null,
                deleted: false
            })
        ]);

        for (const file of files) {
            const destinationFilePath = path.join(destinationPath, file.name);
            const materializedPath = await StorageService.materializeFile(file, destinationFilePath);
            if (materializedPath !== destinationFilePath) {
                await fs.copy(materializedPath, destinationFilePath);
            }
        }

        for (const subfolder of subfolders) {
            await this.materializeFolder(subfolder, path.join(destinationPath, subfolder.name));
        }

        return destinationPath;
    }

    static async getRelativeUploadDir(userId, parentId = null, folder = '', options = {}) {
        const workspaceContext = await this.getWorkspaceContextFromOptions(userId, options);
        const workspace = workspaceContext.workspace;

        if (parentId) {
            const parentFolder = await this.assertUnlockedFolderPath(userId, parentId, workspaceContext);

            return parentFolder.path;
        }

        return folder ? path.join(workspace.rootPath, folder) : workspace.rootPath;
    }

    static async resolveUploadTarget(userId, folderId = null, options = {}) {
        const workspaceContext = await this.getWorkspaceContextFromOptions(userId, {
            ...options,
            requireWrite: true
        });
        const workspace = workspaceContext.workspace;
        const normalizedFolderId = this.normalizeFolderId(folderId);

        if (!normalizedFolderId) {
            return {
                uploadDir: StorageService.isObjectStorage()
                    ? this.getTempPath('chunks', workspace._id.toString(), userId.toString())
                    : path.join(this.uploadDirectory, workspace.rootPath),
                relativeUploadDir: workspace.rootPath,
                folderId: null,
                workspaceContext
            };
        }

        const folder = await this.assertUnlockedFolderPath(userId, normalizedFolderId, workspaceContext);

        return {
            uploadDir: StorageService.isObjectStorage()
                ? this.getTempPath('chunks', workspace._id.toString(), normalizedFolderId)
                : path.join(this.uploadDirectory, folder.path),
            relativeUploadDir: folder.path,
            folderId: normalizedFolderId,
            workspaceContext
        };
    }

    static async uploadFile(userId, fileName, folderId = null, chunk, currentChunk, totalChunks, options = {}) {
        const {
            uploadDir,
            relativeUploadDir,
            folderId: normalizedFolderId,
            workspaceContext
        } = await this.resolveUploadTarget(userId, folderId, options);
        const chunkDir = this.getChunkDir(uploadDir, fileName);

        fs.mkdirSync(uploadDir, { recursive: true });
        fs.mkdirSync(chunkDir, { recursive: true });

        const chunkPath = path.join(chunkDir, `chunk_${currentChunk}`);
        fs.writeFileSync(chunkPath, chunk.buffer);

        // If all chunks are uploaded, combine them
        if (parseInt(currentChunk) >= parseInt(totalChunks)) {
            return await this.combineChunks(chunkDir, uploadDir, relativeUploadDir, fileName, userId, normalizedFolderId, {
                workspaceContext
            });
        }
    }

    static async combineChunks(chunkDir, uploadDir, relativeUploadDir, filename, userId, parentId, options = {}) {
        try {
            const targetPath = path.join(uploadDir, filename);
            const chunks = fs.readdirSync(chunkDir).sort((a, b) => {
                    const aNum = parseInt(a.split('_')[1]);
                    const bNum = parseInt(b.split('_')[1]);
                    return aNum - bNum;
                });

            // Create write stream for the target file
            const writeStream = fs.createWriteStream(targetPath);

            for (const chunk of chunks) {
                const chunkPath = path.join(chunkDir, chunk);
                const chunkData = fs.readFileSync(chunkPath);
                writeStream.write(chunkData);
                fs.unlinkSync(chunkPath); // Remove chunk after appending
            }

            await new Promise((resolve, reject) => {
                writeStream.on('finish', resolve);
                writeStream.on('error', reject);
                writeStream.end();
            });

            const file = await this.saveFileMetadata(targetPath, userId, filename, parentId, relativeUploadDir, {
                requiresVirusScan: true,
                workspaceContext: options.workspaceContext
            });

            await this.recalculateFolderStats(parentId);

            // Remove the chunks directory
            await fs.remove(chunkDir);

            // Emit file uploaded event after file is saved
	            fileEvents.emit(EVENT_TYPES.FILE_UPLOADED, {
	                fileId: file._id,
	                userId,
	                fileName: file.name,
	                filePath: file.path,
	                parentId: file.parent_id,
                    workspaceId: file.workspaceId || null
	            });

            console.log(`File ${filename} successfully combined and saved.`);

            return file;
        } catch (error) {
            console.error('Error combining chunks:', error);
            throw new Error('Failed to combine file chunks');
        }
    }

    static calculateFolderSize(folderPath) {
        let totalSize = 0;

        const items = fs.readdirSync(folderPath);
        items.forEach((item) => {
            const itemPath = path.join(folderPath, item);
            const stats = fs.statSync(itemPath);

            if (stats.isDirectory()) {
                totalSize += this.calculateFolderSize(itemPath);
            } else {
                totalSize += stats.size;
            }
        });

        return totalSize;
    }

    static calculateTotalSize(items, userId) {
        let totalSize = 0;

        if (StorageService.isObjectStorage()) {
            items.forEach(async (item) => {
                const Model = item.type === 'folder' ? Folder : File;
                const record = await Model.findById(item.id);
                if (record && record.userId.toString() === userId.toString()) {
                    totalSize += record.size || 0;
                }
            });

            return totalSize;
        }

        items.forEach(async (item) => {
            try {
                let itemPath;
                if (item.type === 'folder') {
                    const folder = await Folder.findById(item.id);
                    if (!folder || folder.userId.toString() !== userId) {
                        throw new Error(`Folder not found or access denied: ${item.name}`);
                    }
                    itemPath = path.join(this.uploadDirectory, folder.path);
                } else {
                    const file = await File.findById(item.id);
                    if (!file || file.userId.toString() !== userId) {
                        throw new Error(`File not found or access denied: ${item.name}`);
                    }
                    itemPath = path.join(this.uploadDirectory, file.path);
                }

                const stats = fs.statSync(itemPath);
                if (stats.isDirectory()) {
                    totalSize += this.calculateFolderSize(itemPath);
                } else {
                    totalSize += stats.size;
                }
            } catch (error) {
                console.error(`Error calculating size for ${item.name}:`, error);
                throw error;
            }
        });

        return totalSize;
    }

    static async serializeFolder(folder, viewerId, extra = {}) {
        const childScope = {
            parent_id: folder._id.toString(),
            deleted: false,
            ...(folder.workspaceId ? { workspaceId: folder.workspaceId } : { userId: folder.userId.toString() })
        };
        const childCount = await Folder.countDocuments(childScope) +
            await File.countDocuments({
                ...childScope,
                scanStatus: {$in: [null, 'clean']}
            });
        const isLocked = folder.isPasswordProtected && !this.hasValidRecentAccess(folder, viewerId);
        const shared = await this.decorateSharedItem(folder, viewerId, 'folder');
        const outgoingShare = await this.decorateOutgoingShareItem(folder, viewerId, 'folder');
        const ancestors = Array.isArray(extra.ancestors)
            ? extra.ancestors
            : await this.buildFolderAncestorsFromItemScope(folder, folder._id);

        return {
            id: folder._id.toString(),
            name: folder.name,
            isFolder: true,
            hasChildren: childCount > 0,
            parent_id: folder.parent_id ? folder.parent_id.toString() : null,
            workspaceId: folder.workspaceId || null,
            workspaceType: folder.workspaceType || null,
            organizationId: folder.organizationId || null,
            createdByUserId: folder.createdByUserId || folder.userId,
            ownerId: folder.userId,
            ancestors,
            isLocked,
            isPasswordProtected: folder.isPasswordProtected,
            isPrivateVaultRoot: folder.isPrivateVaultRoot === true,
            size: folder.size,
            createdAt: folder.createdAt,
            path: folder.path,
            ...shared,
            ...outgoingShare,
            ...extra
        };
    }

    static async serializeFile(file, viewerId, extra = {}) {
        const isLocked = file.isPasswordProtected && !this.hasValidRecentAccess(file, viewerId);
        const shared = await this.decorateSharedItem(file, viewerId, 'file');
        const outgoingShare = await this.decorateOutgoingShareItem(file, viewerId, 'file');

        return {
            id: file._id.toString(),
            name: file.name,
            isFolder: false,
            parent_id: file.parent_id ? file.parent_id.toString() : null,
            workspaceId: file.workspaceId || null,
            workspaceType: file.workspaceType || null,
            organizationId: file.organizationId || null,
            createdByUserId: file.createdByUserId || file.userId,
            ownerId: file.userId,
            size: file.size,
            createdAt: file.createdAt,
            mimetype: file.mimetype,
            type: file.mimetype ? file.mimetype.split('/')[0] : 'unknown',
            path: file.path,
            scanStatus: file.scanStatus || null,
            scanProgress: file.scanProgress || 0,
            scanResult: file.scanResult || null,
            scanDate: file.scanDate || null,
            contentIntelligence: file.contentIntelligence ? {
                status: file.contentIntelligence.status || null,
                stage: file.contentIntelligence.stage || null,
                progress: file.contentIntelligence.progress || 0,
                textExcerpt: file.contentIntelligence.textExcerpt || '',
                language: file.contentIntelligence.language || null,
                classification: file.contentIntelligence.classification || null,
                tags: file.contentIntelligence.tags || [],
                summary: file.contentIntelligence.summary || '',
                provider: file.contentIntelligence.provider || null,
                model: file.contentIntelligence.model || null,
                extractionMethod: file.contentIntelligence.extractionMethod || null,
                ocrProvider: file.contentIntelligence.ocrProvider || null,
                ocrModel: file.contentIntelligence.ocrModel || null,
                ocrFallbackApplied: file.contentIntelligence.ocrFallbackApplied === true,
                ocrError: file.contentIntelligence.ocrError || null,
                ocrApplied: file.contentIntelligence.ocrApplied === true,
                imageRecognized: file.contentIntelligence.imageRecognized === true,
                error: file.contentIntelligence.error || null,
                lastRunAt: file.contentIntelligence.lastRunAt || null,
                completedAt: file.contentIntelligence.completedAt || null
            } : null,
            isLocked,
            isPasswordProtected: file.isPasswordProtected,
            ...shared,
            ...outgoingShare,
            ...extra
        };
    }

    static async *streamSharedFilesGenerator(userId, parentId = null, search = null) {
        if (!parentId) {
            const shares = await OrganizationShareService.getSharesForUser(userId);

            for (const share of shares) {
                const Model = share.itemType === 'folder' ? Folder : File;
                const item = await Model.findOne({
                    _id: share.itemId,
                    deleted: false
                });

                if (!item) {
                    continue;
                }

                if (share.itemType === 'file') {
                    const visibleFile = await this.prepareSharedFileForRecipient(item, userId);
                    if (!visibleFile) {
                        continue;
                    }
                }

                if (search && !new RegExp(this.escapeRegExp(search), 'i').test(item.name)) {
                    continue;
                }

                const shareMeta = {
                    isShared: true,
                    shareId: share._id.toString(),
                    permission: share.permission
                };

                yield share.itemType === 'folder'
                    ? await this.serializeFolder(item, userId, shareMeta)
                    : await this.serializeFile(item, userId, shareMeta);
            }

            return;
        }

        const parentFolder = await this.getAccessibleFolderById(userId, parentId);
        if (!parentFolder) {
            throw new Error('Shared folder not found or access denied');
        }
        this.assertPasswordAccess(parentFolder, userId);

        const foldersQuery = {
            ...(parentFolder.workspaceId ? { workspaceId: parentFolder.workspaceId } : { userId: parentFolder.userId }),
            parent_id: parentId,
            deleted: false
        };
        const filesQuery = {
            ...(parentFolder.workspaceId ? { workspaceId: parentFolder.workspaceId } : { userId: parentFolder.userId }),
            parent_id: parentId,
            deleted: false
        };

        if (search) {
            foldersQuery.name = new RegExp(this.escapeRegExp(search), 'i');
            filesQuery.name = new RegExp(this.escapeRegExp(search), 'i');
        }

        const foldersStream = Folder.find(foldersQuery).cursor();
        for await (const folder of foldersStream) {
            yield await this.serializeFolder(folder, userId, { isShared: true });
        }

        const filesStream = File.find(filesQuery).cursor();
        for await (const file of filesStream) {
            const visibleFile = await this.prepareSharedFileForRecipient(file, userId);
            if (!visibleFile) {
                continue;
            }

            yield await this.serializeFile(visibleFile, userId, { isShared: true });
        }
    }

    static async *streamSharedByMeGenerator(userId, search = null) {
        const now = new Date();
        const [shares, publicLinks] = await Promise.all([
            Share.find(this.getOutgoingShareManagementFilter(userId)).sort({ updatedAt: -1 }).lean(),
            ShareLink.find(this.getShareLinkManagementFilter(userId)).sort({ updatedAt: -1 }).lean()
        ]);
        const matcher = search ? new RegExp(this.escapeRegExp(search), 'i') : null;

        for (const share of shares) {
            const Model = share.itemType === 'folder' ? Folder : File;
            const item = await Model.findOne({
                _id: share.itemId,
                userId: userId.toString()
            });

            if (!item) {
                continue;
            }

            const targetType = share.targetType || 'member';
            const recipient = targetType === 'member'
                ? await User.findById(share.recipientId).select('_id username email').lean()
                : null;
            const recipientName = share.targetLabel ||
                (recipient ? recipient.username : (
                    targetType === 'team'
                        ? 'Team share'
                        : targetType === 'organization'
                            ? 'Organization share'
                            : targetType === 'external'
                                ? share.recipientId
                                : 'Unknown user'
                ));
            const recipientEmail = recipient ? recipient.email : '';

            if (matcher &&
                !matcher.test(item.name) &&
                !matcher.test(recipientName) &&
                !matcher.test(recipientEmail)) {
                continue;
            }

            const shareMeta = {
                isSharedByMe: true,
                shareId: share._id.toString(),
                recipientId: recipient ? recipient._id.toString() : share.recipientId,
                recipientUsername: recipientName,
                recipientEmail,
                shareTargetType: targetType,
                sharedWith: recipientEmail && !share.targetLabel ? `${recipientName} <${recipientEmail}>` : recipientName,
                sharedWithList: recipientEmail && !share.targetLabel ? `${recipientName} <${recipientEmail}>` : recipientName,
                permission: share.permission,
                shareStatus: item.deleted ? 'Item deleted' : (share.expiresAt && share.expiresAt <= now ? 'Expired' : 'Active'),
                itemDeleted: item.deleted === true,
                sharedAt: share.createdAt,
                shareUpdatedAt: share.updatedAt,
                expiresAt: share.expiresAt,
                maxDownloads: share.maxDownloads || null,
                downloadCount: share.downloadCount || 0,
                lastDownloadedAt: share.lastDownloadedAt || null
            };

            yield share.itemType === 'folder'
                ? await this.serializeFolder(item, userId, shareMeta)
                : await this.serializeFile(item, userId, shareMeta);
        }

        for (const publicLink of publicLinks) {
            const Model = publicLink.itemType === 'folder' ? Folder : File;
            const item = await Model.findOne({
                _id: publicLink.itemId,
                userId: userId.toString()
            });

            if (!item) {
                continue;
            }

            if (matcher &&
                !matcher.test(item.name) &&
                !matcher.test('Anyone with link')) {
                continue;
            }

            const publicLinkMeta = {
                isSharedByMe: true,
                shareKind: 'publicLink',
                hasPublicLink: true,
                publicLinkId: publicLink._id.toString(),
                publicLinkIds: [publicLink._id.toString()],
                publicLinkCount: 1,
                shareCount: 1,
                sharedWith: 'Anyone with link',
                sharedWithList: 'Anyone with link',
                permission: publicLink.permission,
                shareStatus: item.deleted ? 'Item deleted' : (publicLink.expiresAt && publicLink.expiresAt <= now ? 'Expired' : 'Active'),
                itemDeleted: item.deleted === true,
                sharedAt: publicLink.createdAt,
                shareUpdatedAt: publicLink.updatedAt,
                expiresAt: publicLink.expiresAt,
                accessCount: publicLink.accessCount || 0,
                maxDownloads: publicLink.maxDownloads || null,
                downloadCount: publicLink.downloadCount || 0,
                lastDownloadedAt: publicLink.lastDownloadedAt,
                lastAccessedAt: publicLink.lastAccessedAt,
                tokenPreview: publicLink.tokenPreview
            };

            yield publicLink.itemType === 'folder'
                ? await this.serializeFolder(item, userId, publicLinkMeta)
                : await this.serializeFile(item, userId, publicLinkMeta);
        }
    }

    static async *streamFilesGenerator(userId, parentId = null, search = null, options = {}) {
        try {
            if (options.sharedByMe) {
                yield* this.streamSharedByMeGenerator(userId, search);
                return;
            }

            if (options.shared) {
                yield* this.streamSharedFilesGenerator(userId, parentId, search);
                return;
            }

            const includeFileAncestors = Boolean(search);
            const workspaceContext = await this.getWorkspaceContextFromOptions(userId, options);
            const workspaceId = workspaceContext.workspace._id.toString();

            if (!search && parentId) {
                await this.assertUnlockedFolderPath(userId, parentId, workspaceContext);
            }

            let foldersQuery = { 
                workspaceId,
                deleted: false
            };

            let filesQuery = {
                workspaceId,
                deleted: false,
                scanStatus: {$in: [null, 'clean']}
            };

            // Add parent_id filter only if not searching
            if (!search && parentId !== undefined) {
                foldersQuery.parent_id = parentId || null;
                filesQuery.parent_id = parentId || null;

                if (!parentId) {
                    foldersQuery.isPrivateVaultRoot = { $ne: true };
                }
            }

            // Add search filter if provided
            if (search) {
                const searchRegex = SearchService.buildLiteralRegex(search);
                const ocrSearchRegex = SearchService.buildOcrTolerantRegex(search);
                foldersQuery.name = searchRegex;
                filesQuery.$or = SearchService.buildContentSearchFilter(searchRegex, ocrSearchRegex).$or;
            }

            // Stream folders using a Mongoose cursor
            const foldersStream = Folder.find(foldersQuery).cursor();

            for await (const folder of foldersStream) {
                if (search && (
                    (folder.isPasswordProtected && !this.hasValidRecentAccess(folder, userId)) ||
                    await SearchService.hasLockedProtectedAncestor(userId, folder.parent_id, workspaceContext)
                )) {
                    continue;
                }

                yield await this.serializeFolder(folder, userId, {
                    ancestors: await this.buildFolderAncestors(userId, folder._id, { workspaceContext })
                });
            }

            // Stream files using another Mongoose cursor
            const filesStream = File.find(filesQuery).cursor();

            for await (const file of filesStream) {
                if (search && await SearchService.hasLockedProtectedAncestor(userId, file.parent_id, workspaceContext)) {
                    continue;
                }

                yield await this.serializeFile(file, userId, includeFileAncestors
                    ? { ancestors: await this.buildFolderAncestors(userId, file.parent_id, { workspaceContext }) }
                    : {});
            }
        } catch (error) {
            console.error('Error streaming files:', error);
            throw error;
        }
    }

    static async getDashboardSummary(userId, options = {}) {
        const workspaceContext = await this.getWorkspaceContextFromOptions(userId, options);
        const scopedQuery = this.getScopedItemQuery(workspaceContext);
        const filesQuery = {
            ...scopedQuery,
            deleted: false,
            scanStatus: { $in: [null, 'clean'] }
        };

        const allFilesQuery = {
            ...scopedQuery,
            deleted: false
        };

        const foldersQuery = {
            ...scopedQuery,
            deleted: false
        };

        const [
            fileCount,
            folderCount,
            protectedFileCount,
            protectedFolderCount,
            rootFileCount,
            rootFolderCount,
            storageResult,
            mimeTypeResult,
            scanStatusResult,
            recentFiles,
            recentFolders
        ] = await Promise.all([
            File.countDocuments(filesQuery),
            Folder.countDocuments(foldersQuery),
            File.countDocuments({ ...filesQuery, isPasswordProtected: true }),
            Folder.countDocuments({ ...foldersQuery, isPasswordProtected: true }),
            File.countDocuments({ ...filesQuery, parent_id: null }),
            Folder.countDocuments({ ...foldersQuery, parent_id: null, isPrivateVaultRoot: { $ne: true } }),
            File.aggregate([
                { $match: filesQuery },
                {
                    $group: {
                        _id: null,
                        totalBytes: { $sum: { $ifNull: ['$size', 0] } }
                    }
                }
            ]),
            File.aggregate([
                { $match: filesQuery },
                {
                    $group: {
                        _id: '$mimetype',
                        count: { $sum: 1 },
                        bytes: { $sum: { $ifNull: ['$size', 0] } }
                    }
                }
            ]),
            File.aggregate([
                { $match: allFilesQuery },
                {
                    $group: {
                        _id: { $ifNull: ['$scanStatus', 'unscanned'] },
                        count: { $sum: 1 }
                    }
                }
            ]),
            File.find(filesQuery)
                .select('_id name path mimetype size createdAt updatedAt parent_id isPasswordProtected')
                .sort({ createdAt: -1 })
                .limit(8)
                .lean(),
            Folder.find(foldersQuery)
                .select('_id name path size createdAt parent_id isPasswordProtected userAccess')
                .where('isPrivateVaultRoot').ne(true)
                .sort({ createdAt: -1 })
                .limit(8)
                .lean()
        ]);

        const recentFileItems = (await Promise.all(recentFiles.map(async (file) => {
            if (await SearchService.hasLockedProtectedAncestor(userId, file.parent_id, workspaceContext)) {
                return null;
            }

            return {
                id: file._id.toString(),
                name: file.name,
                path: file.path,
                mimetype: file.mimetype,
                type: file.mimetype,
                size: file.size || 0,
                createdAt: file.createdAt,
                isFolder: false,
                isPasswordProtected: file.isPasswordProtected,
                parent_id: file.parent_id,
                ancestors: await this.buildFolderAncestors(userId, file.parent_id, { workspaceContext })
            };
        }))).filter(Boolean);

        const recentFolderItems = (await Promise.all(recentFolders.map(async (folder) => {
            if ((folder.isPasswordProtected && !this.hasValidRecentAccess(folder, userId)) ||
                await SearchService.hasLockedProtectedAncestor(userId, folder.parent_id, workspaceContext)) {
                return null;
            }

            return {
                id: folder._id.toString(),
                name: folder.name,
                path: folder.path,
                type: 'Folder',
                size: folder.size || 0,
                createdAt: folder.createdAt,
                isFolder: true,
                isPasswordProtected: folder.isPasswordProtected,
                parent_id: folder.parent_id,
                ancestors: await this.buildFolderAncestors(userId, folder._id, { workspaceContext })
            };
        }))).filter(Boolean);

        const recentItems = [...recentFileItems, ...recentFolderItems]
            .sort((first, second) => new Date(second.createdAt) - new Date(first.createdAt))
            .slice(0, 8);

        const totalBytes = storageResult[0]?.totalBytes || 0;
        const breakdownByCategory = new Map();

        mimeTypeResult.forEach((entry) => {
            const category = this.getFileCategory(entry._id);
            const current = breakdownByCategory.get(category) || {
                category,
                count: 0,
                bytes: 0,
                iconCls: this.getFileCategoryIcon(category)
            };

            current.count += entry.count || 0;
            current.bytes += entry.bytes || 0;
            breakdownByCategory.set(category, current);
        });

        const typeBreakdown = Array.from(breakdownByCategory.values())
            .sort((first, second) => second.bytes - first.bytes)
            .map((entry) => ({
                ...entry,
                percent: totalBytes > 0 ? Math.round((entry.bytes / totalBytes) * 100) : 0
            }));

        const scanCounts = scanStatusResult.reduce((result, entry) => {
            result[entry._id || 'unscanned'] = entry.count || 0;
            return result;
        }, {
            pending: 0,
            scanning: 0,
            clean: 0,
            infected: 0,
            unscanned: 0
        });

        const scanTotal = Object.values(scanCounts).reduce((sum, value) => sum + (Number(value) || 0), 0);
        scanCounts.ready = fileCount;
        scanCounts.total = scanTotal;

        return {
            counts: {
                files: fileCount,
                folders: folderCount,
                protectedItems: protectedFileCount + protectedFolderCount,
                rootItems: rootFileCount + rootFolderCount
            },
            storage: {
                totalBytes
            },
            scan: scanCounts,
            typeBreakdown,
            recentItems,
            generatedAt: new Date()
        };
    }

    static async updateFolderSize(folderId) {
        if (StorageService.isObjectStorage()) {
            return this.recalculateFolderStats(folderId);
        }

        const folder = await Folder.findById(folderId);
        if (!folder) return;

        const folderPath = path.join(this.uploadDirectory, folder.path);
        if (fs.existsSync(folderPath)) {
            const size = this.calculateFolderSize(folderPath);
            await Folder.updateOne({ _id: folderId }, { size });

            // Update parent folder sizes recursively
            if (folder.parent_id) {
                await this.updateFolderSize(folder.parent_id);
            }
        }
    }

    static async recalculateFolderStats(folderId, options = {}) {
        if (!folderId || folderId === 'root') {
            return;
        }

        try {
            const visited = options.visited || new Set();
            const normalizedFolderId = folderId.toString();

            if (visited.has(normalizedFolderId)) {
                return { totalSize: 0, fileCount: 0, folderCount: 0 };
            }
            visited.add(normalizedFolderId);

            const folder = await Folder.findById(folderId);
            if (!folder) return;

            const [files, subfolders] = await Promise.all([
                File.find({
                    parent_id: normalizedFolderId,
                    deleted: false,
                    scanStatus: { $in: [null, 'clean'] }
                }).select('size'),
                Folder.find({ parent_id: normalizedFolderId, deleted: false })
            ]);

            let totalSize = files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
            const fileCount = files.length;
            const folderCount = subfolders.length;

            for (const subfolder of subfolders) {
                const childStats = await this.recalculateFolderStats(subfolder._id, {
                    visited,
                    propagate: false
                });
                totalSize += Number(childStats && childStats.totalSize) || 0;
            }

            folder.size = totalSize;
            folder.fileCount = fileCount;
            folder.folderCount = folderCount;
            await folder.save();

            if (options.propagate !== false && folder.parent_id) {
                await this.recalculateFolderStats(folder.parent_id, {
                    visited: new Set(),
                    propagate: true
                });
            }

            return { totalSize, fileCount, folderCount };
        } catch (error) {
            console.error(`Error recalculating folder stats: ${error.message}`);
            throw error;
        }
    }

    static async deleteFile(userId, fileId, options = {}) {
        const workspaceContext = await this.getWorkspaceContextFromOptions(userId, {
            ...options,
            requireWrite: true
        });
        const file = await File.findOne({
            _id: fileId,
            ...this.getScopedItemQuery(workspaceContext)
        });
        if (!file) {
            throw new Error('File not found');
        }
        await this.assertUnlockedItemAndAncestors(userId, file, workspaceContext);
        await StorageService.deleteFile(file);
        file.deleted = true; // Assuming you have a 'deleted' field
        await file.save();
        StorageInsightsService.invalidateUser(this.getStorageInsightKey(workspaceContext, userId));

        if (file.parent_id) {
            await this.recalculateFolderStats(file.parent_id);
        }
    }

    static async deleteMultipleFiles(userId, ids, parentId, options = {}) {
        const workspaceContext = await this.getWorkspaceContextFromOptions(userId, {
            ...options,
            requireWrite: true
        });
        const scopedQuery = this.getScopedItemQuery(workspaceContext);
        // Find files and folders to be deleted
        const files = await File.find({ _id: { $in: ids }, ...scopedQuery, deleted: false });
        const folders = await Folder.find({ _id: { $in: ids }, ...scopedQuery, deleted: false });

        const deletionResults = {
            filesDeleted: 0,
            foldersDeleted: 0,
            errors: []
        };

        // Delete files
        for (const file of files) {
            try {
                await this.assertUnlockedItemAndAncestors(userId, file, workspaceContext);

                if (!file.path) {
                    console.warn(`File path is undefined for file ID: ${file._id}`);
                    deletionResults.errors.push(`Invalid path for file: ${file.name}`);
                    continue;
                }

                await StorageService.deleteFile(file);

                // Mark file as deleted in database
                await File.updateOne({ _id: file._id }, { $set: { deleted: true } });
                console.log(`File marked as deleted in DB: ${file.path}`);
                deletionResults.filesDeleted++;
            } catch (error) {
                console.error(`Error deleting file: ${file.path}, Error: ${error.message}`);
                deletionResults.errors.push(`Failed to delete file: ${file.name}`);
            }
        }

        // Process folders and their contents
        for (const folder of folders) {
            try {
                this.assertNotPrivateVaultRoot(folder, 'deleted');
                await this.assertUnlockedItemAndAncestors(userId, folder, workspaceContext);

                if (!folder.path) {
                    console.warn(`Folder path is undefined for folder ID: ${folder._id}`);
                    deletionResults.errors.push(`Invalid path for folder: ${folder.name}`);
                    continue;
                }

                // Recursively delete folder and its contents
                await this.deleteFolderRecursively(folder._id, userId, { workspaceContext });
                console.log(`Folder and contents deleted: ${folder.path}`);
                deletionResults.foldersDeleted++;
            } catch (error) {
                console.error(`Error deleting folder: ${folder.path}, Error: ${error.message}`);
                deletionResults.errors.push(`Failed to delete folder: ${folder.name}`);
            }
        }

        // Recalculate parent folder stats if needed
        if (parentId) {
            try {
                await this.recalculateFolderStats(parentId);
            } catch (error) {
                console.error(`Error recalculating folder stats: ${error.message}`);
            }
        }

        StorageInsightsService.invalidateUser(this.getStorageInsightKey(workspaceContext, userId));

        return {
            success: deletionResults.errors.length === 0,
            ...deletionResults
        };
    }

    static async deleteFolderRecursively(folderId, userId, options = {}) {
        try {
            const workspaceContext = await this.getWorkspaceContextFromOptions(userId, options);
            const scopedQuery = this.getScopedItemQuery(workspaceContext);
            // Find the folder to delete
            const folderToDelete = await Folder.findOne({ _id: folderId, ...scopedQuery });
            if (!folderToDelete) {
                throw new Error(`Folder with ID ${folderId} not found.`);
            }
            this.assertNotPrivateVaultRoot(folderToDelete, 'deleted');
            await this.assertUnlockedItemAndAncestors(userId, folderToDelete, workspaceContext);

            // Find all subfolders and files
            const subFolders = await Folder.find({
                path: new RegExp(`^${folderToDelete.path}/`),
                ...scopedQuery,
                deleted: false
            });
            const subFiles = await File.find({
                path: new RegExp(`^${folderToDelete.path}/`),
                ...scopedQuery,
                deleted: false
            });

            for (const file of subFiles) {
                await StorageService.deleteFile(file);
            }

            // Mark all items as deleted in database
            await Folder.updateMany(
                { _id: { $in: [folderId, ...subFolders.map(f => f._id)] } },
                { $set: { deleted: true } }
            );
            await File.updateMany(
                { _id: { $in: subFiles.map(f => f._id) } },
                { $set: { deleted: true } }
            );

            if (!StorageService.isObjectStorage()) {
                const folderPath = path.join(this.uploadDirectory, folderToDelete.path);
                if (fs.existsSync(folderPath)) {
                    fs.rmSync(folderPath, { recursive: true, force: true });
                    console.log(`Folder physically deleted: ${folderPath}`);
                }
            }

            console.log(`Folder ${folderToDelete.name} and its contents deleted completely.`);
            StorageInsightsService.invalidateUser(this.getStorageInsightKey(workspaceContext, userId));
            return { success: true };
        } catch (error) {
            console.error('Error in deleteFolderRecursively:', error);
            throw error;
        }
    }

    static async viewFile(userId, fileId) {
        const file = await this.getAccessibleFileById(userId, fileId);
        
        if (!file) {
            throw new Error('File not found');
        }

        await this.assertSharedFileReadyForAccess(file, userId);
        const workspaceContext = this.getWorkspaceContextFromItem(file);
        await this.assertUnlockedItemAndAncestors(userId, file, workspaceContext);

        const exists = await StorageService.fileExists(file);

        if (!exists) {
            throw new Error('File not found in storage');
        }

        const mimeType = file.mimetype || mime.getType(file.name);
        return { file, mimeType };
    }

    static async getFileById(userId, fileId) {
        return this.getAccessibleFileById(userId, fileId);
    }

    static async updateFileContent(userId, fileId, content) {
        if (typeof content !== 'string') {
            throw new Error('Content must be a string');
        }

        const file = await this.getFileById(userId, fileId);
        if (!file) {
            throw new Error('File not found');
        }

        if (file.userId.toString() !== userId.toString()) {
            const error = new Error('Only the owner can edit this file');
            error.statusCode = 403;
            throw error;
        }

        const workspaceContext = this.getWorkspaceContextFromItem(file);
        await this.assertUnlockedItemAndAncestors(userId, file, workspaceContext);

        const exists = await StorageService.fileExists(file);
        if (!exists) {
            throw new Error('File not found in storage');
        }

        const mimeType = file.mimetype || mime.getType(file.name);
        if (!['text/plain', 'application/json'].includes(mimeType)) {
            throw new Error('Only text and JSON files can be edited');
        }

        const filePath = StorageService.isObjectStorage()
            ? this.getTempPath('edits', userId, file._id.toString(), file.name)
            : path.join(this.uploadDirectory, file.path);

        await fs.ensureDir(path.dirname(filePath));
        await fs.writeFile(filePath, content, 'utf8');

        const stats = fs.statSync(filePath);
        if (StorageService.isObjectStorage()) {
            await StorageService.uploadFile(file, filePath, {
                'Content-Type': mimeType || 'text/plain',
                'Original-Name': file.name
            });
            await fs.remove(filePath);
        }

        file.size = stats.size;
        await file.save();
        StorageInsightsService.invalidateUser(this.getStorageInsightKey(workspaceContext, userId));

        if (file.parent_id) {
            await this.recalculateFolderStats(file.parent_id);
        }

        return file;
    }

    static async createFolder(userId, folderName, parent_id = null, options = {}) {
        if (!userId || !folderName) {
            throw new Error('userId and folderName are required');
        }
        const workspaceContext = await this.getWorkspaceContextFromOptions(userId, {
            ...options,
            requireWrite: true
        });
        const workspace = workspaceContext.workspace;
        const workspacePatch = this.getWorkspaceItemPatch(workspaceContext, userId);

        if (folderName.indexOf('..') > -1) {
            throw new Error('Invalid target folder. Directory traversal is not allowed.');
        }

        // Determine the folder's relative path based on parent_id
        let folderPath = workspace.rootPath; // Start the path with workspace root as the base directory

        if (parent_id) {
            const parentFolder = await this.assertUnlockedFolderPath(userId, parent_id, workspaceContext);
            folderPath = path.join(parentFolder.path, folderName); // Path relative to parent folder
        } else {
            folderPath = path.join(workspace.rootPath, folderName); // Top-level folder under workspace
        }

        if (!StorageService.isObjectStorage()) {
            const fullPath = path.join(FileService.uploadDirectory, folderPath); // Full path for filesystem
            fs.mkdirSync(fullPath, { recursive: true });
        }

        // Save folder information in the database
        const newFolder = new Folder({
            userId,
            ...workspacePatch,
            parent_id: parent_id,
            name: folderName,
            path: folderPath, // Save as relative path including userId
            createdAt: new Date()
        });

        await newFolder.save();
        StorageInsightsService.invalidateUser(this.getStorageInsightKey(workspaceContext, userId));

        return newFolder;
    }

    static async compressFiles(userId, items, folder = '', zipFileName = null, parentId = null, progressCallback = null, archiveType = 'zip', compressionLevel = 6, options = {}) {
        const workspaceContext = await this.getWorkspaceContextFromOptions(userId, {
            ...options,
            requireWrite: true
        });
        const scopedQuery = this.getScopedItemQuery(workspaceContext);
        // Validate items exist and user has access
        const validatedItems = [];
        const affectedFolders = new Set(); // Track folders that need size recalculation
        const compressionTempRoot = this.getTempPath('compression', userId, `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);

        for (const itemId of items) {
            try {
                let item;
                let itemPath;
                let itemType;
                let itemName;
                let itemParentId;

                // Try to find the item as a file first
                const file = await File.findOne({ _id: itemId, ...scopedQuery, deleted: false });
                if (file) {
                    await this.assertUnlockedItemAndAncestors(userId, file, workspaceContext);
                    itemType = 'file';
                    itemPath = StorageService.isObjectStorage()
                        ? await StorageService.materializeFile(file, path.join(compressionTempRoot, 'files', file._id.toString(), file.name))
                        : path.join(this.uploadDirectory, file.path);
                    itemName = file.name;
                    itemParentId = file.parent_id;
                } else {
                    // If not found as file, try as a folder
                    const folder = await Folder.findOne({ _id: itemId, ...scopedQuery, deleted: false });
                    if (folder) {
                        this.assertNotPrivateVaultRoot(folder, 'compressed');
                        await this.assertUnlockedItemAndAncestors(userId, folder, workspaceContext);
                        itemType = 'folder';
                        itemPath = StorageService.isObjectStorage()
                            ? await this.materializeFolder(folder, path.join(compressionTempRoot, 'folders', folder._id.toString(), folder.name))
                            : path.join(this.uploadDirectory, folder.path);
                        itemName = folder.name;
                        itemParentId = folder.parent_id;
                    } else {
                        throw new Error(`Item not found or access denied: ${itemId}`);
                    }
                }

                // Add parent folder to affected folders list
                if (itemParentId) {
                    affectedFolders.add(itemParentId.toString());
                }

                // Verify path exists
                if (!fs.existsSync(itemPath)) {
                    throw new Error(`Path not found for ${itemName}: ${itemPath}`);
                }

                validatedItems.push({
                    id: itemId,
                    type: itemType,
                    name: itemName,
                    fullPath: itemPath
                });
            } catch (error) {
                console.error(`Error validating item ${itemId}:`, error);
                throw error;
            }
        }

        if (!folder) {
            folder = '';
            parentId = null;
        }

        const key = `${userId}-${zipFileName}`;
        const abortController = new AbortController();
        this.ongoingCompressions.set(key, { abortController, activeArchive: null, output: null });

        const signal = abortController.signal;

        signal.addEventListener('abort', () => {
            console.log(`Aborting compression for ${zipFileName}.`);
            if (archive) archive.abort();
            if (output) {
                output.destroy();
                if (fs.existsSync(zipFilePath)) {
                    fs.unlink(zipFilePath, (err) => {
                        if (err) console.error(`Error deleting partial ZIP file: ${err.message}`);
                    });
                }
            }
        });

        // Determine file extension and mime type based on archive type
        let fileExtension, mimeType, sevenZFormat;
        switch (archiveType.toLowerCase()) {
            case '7z':
                fileExtension = '.7z';
                mimeType = 'application/x-7z-compressed';
                sevenZFormat = '7z';
                break;
            case 'tgz':
                fileExtension = '.tar.gz';
                mimeType = 'application/gzip';
                sevenZFormat = 'tgz';
                break;
            case 'zip':
            default:
                fileExtension = '.zip';
                mimeType = 'application/zip';
                sevenZFormat = 'zip';
        }

        const timestamp = Date.now();
        const name = zipFileName || `compressed_${timestamp}${fileExtension}`;
        const relativeUploadDir = await this.getRelativeUploadDir(userId, parentId, folder, { workspaceContext });
        const targetFolder = StorageService.isObjectStorage()
            ? path.join(compressionTempRoot, 'output')
            : path.join(this.uploadDirectory, relativeUploadDir);
        const zipFilePath = path.join(targetFolder, name);

        if (!fs.existsSync(targetFolder)) {
            fs.mkdirpSync(targetFolder);
        }

        const filePaths = validatedItems.map(item => item.fullPath);

        try {
            const result = await CompressionService.compressFiles(filePaths, zipFilePath, archiveType, compressionLevel, progressCallback);
            
            const compressedFile = await this.saveFileMetadata(zipFilePath, userId, name, parentId, relativeUploadDir, { workspaceContext });
            compressedFile.mimetype = mimeType;
            compressedFile.size = result.archiveSize;
            await compressedFile.save();
            StorageInsightsService.invalidateUser(this.getStorageInsightKey(workspaceContext, userId));

            // Recalculate sizes for all affected folders
            for (const folderId of affectedFolders) {
                await this.recalculateFolderStats(folderId);
            }

            // If the compressed file was saved to a folder, recalculate that folder's size too
            if (parentId) {
                await this.recalculateFolderStats(parentId);
            }

            if (StorageService.isObjectStorage()) {
                await fs.remove(compressionTempRoot);
            }

            return { success: true, file: compressedFile };
        } catch (error) {
            console.error('Error in compression process:', error);
            if (fs.existsSync(zipFilePath)) {
                fs.unlink(zipFilePath, () => {});
            }
            if (StorageService.isObjectStorage()) {
                await fs.remove(compressionTempRoot);
            }
            this.ongoingCompressions.delete(key);
            throw error;
        }
    }

    static async decompressFile(userId, zipFilePath, targetFolder = '.', parentId = null, options = {}) {
        const workspaceContext = await this.getWorkspaceContextFromOptions(userId, {
            ...options,
            requireWrite: true
        });
        const workspace = workspaceContext.workspace;
        const workspacePatch = this.getWorkspaceItemPatch(workspaceContext, userId);
        const scopedQuery = this.getScopedItemQuery(workspaceContext);
        const io = socket.getIO();
        const progressId = options.progressId || null;
        const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
        const archiveLogicalPath = zipFilePath;
        const decompressionTempRoot = this.getTempPath('decompression', userId, `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);
        const rootDir = StorageService.isObjectStorage()
            ? path.resolve(decompressionTempRoot)
            : path.resolve(path.join(this.uploadDirectory, workspace.rootPath));
        let targetDir;
        let parentFolderId = parentId;
        let parentFolderPath = '';

        if (parentId) {
            const parentFolder = await this.assertUnlockedFolderPath(userId, parentId, workspaceContext);
            targetDir = StorageService.isObjectStorage()
                ? path.join(decompressionTempRoot, 'output')
                : path.join(this.uploadDirectory, parentFolder.path);
            parentFolderPath = parentFolder.path;
        } else {
            targetDir = StorageService.isObjectStorage()
                ? path.join(decompressionTempRoot, 'output')
                : rootDir;
            parentFolderPath = workspace.rootPath;
        }

        if (StorageService.isObjectStorage()) {
            const archiveFile = await File.findOne({ ...scopedQuery, path: archiveLogicalPath, deleted: false });
            if (!archiveFile) {
                throw new Error('Archive file not found');
            }

            await this.assertUnlockedItemAndAncestors(userId, archiveFile, workspaceContext);
            zipFilePath = await StorageService.materializeFile(
                archiveFile,
                path.join(decompressionTempRoot, 'archive', archiveFile.name)
            );
        } else {
            const archiveFile = await File.findOne({ ...scopedQuery, path: archiveLogicalPath, deleted: false });
            if (!archiveFile) {
                throw new Error('Archive file not found');
            }
            await this.assertUnlockedItemAndAncestors(userId, archiveFile, workspaceContext);
            zipFilePath = path.join(this.uploadDirectory, zipFilePath);
        }

        await fs.ensureDir(targetDir);

        if (!targetDir.startsWith(rootDir)) {
            throw new Error('Invalid target folder. Directory traversal is not allowed.');
        }

        // Step 1: Extract all files first (fast operation)
        const zip = new AdmZip(zipFilePath);
        const zipEntries = zip.getEntries();
        const totalEntries = zipEntries.length;
        let processedEntries = 0;

        // Process each entry individually
        for (const entry of zipEntries) {
            const normalizedPath = entry.entryName.replace(/\\/g, '/');
            
            // Extract the current entry maintaining the directory structure
            if (!entry.isDirectory) {
                zip.extractEntryTo(
                    entry.entryName,    // Entry name with path
                    targetDir,          // Target directory
                    true,              // Maintain full path
                    true               // Overwrite
                );
            }
            
            processedEntries++;
            if (processedEntries % Math.max(1, Math.floor(totalEntries * 0.01)) === 0) {
                const progress = Math.round((processedEntries / totalEntries) * 100);
                const progressPayload = {
                    userId,
                    progressId,
                    progress,
                    fileName: path.basename(zipFilePath)
                };

                io.to(userId.toString()).emit('decompressionProgress', progressPayload);
                if (onProgress) {
                    onProgress(progressPayload);
                }
            }
        }
        
        // Step 2: Collect file and folder information
        const folders = new Map();
        const files = [];
        
        // First pass: collect all directories
        for (const entry of zipEntries) {
            const normalizedPath = entry.entryName.replace(/\\/g, '/');
            
            if (entry.isDirectory) {
                const cleanPath = normalizedPath.replace(/\/$/, '');
                const parts = cleanPath.split('/');
                let currentPath = '';
                
                for (let i = 0; i < parts.length; i++) {
                    const part = parts[i];
                    const prevPath = currentPath;
                    currentPath = parts.slice(0, i + 1).join('/');
                    
                    if (!folders.has(currentPath)) {
                        folders.set(currentPath, {
                            name: part,
                            fullPath: currentPath,
                            parent: prevPath || null
                        });
                    }
                }
            } else {
                const dirPath = path.dirname(normalizedPath);
                if (dirPath !== '.' && !folders.has(dirPath)) {
                    const parts = dirPath.split('/');
                    let currentPath = '';
                    
                    for (let i = 0; i < parts.length; i++) {
                        const part = parts[i];
                        const prevPath = currentPath;
                        currentPath = parts.slice(0, i + 1).join('/');
                        
                        if (!folders.has(currentPath)) {
                            folders.set(currentPath, {
                                name: part,
                                fullPath: currentPath,
                                parent: prevPath || null
                            });
                        }
                    }
                }
                
                files.push({
                    path: normalizedPath,
                    name: path.basename(normalizedPath),
                    parent: dirPath === '.' ? null : dirPath
                });
            }
        }

        // Step 3: Create folders in correct order
        const folderCache = new Map();
        const sortedFolders = Array.from(folders.values())
            .sort((a, b) => a.fullPath.split('/').length - b.fullPath.split('/').length);

        // Create folders
        for (const folder of sortedFolders) {
            let parentId = parentFolderId;

            if (folder.parent) {
                const parentFolder = folderCache.get(folder.parent);
                if (parentFolder) {
                    parentId = parentFolder._id;
                }
            }

            console.log(`Creating folder`, folder);

            const newFolder = new Folder({
                name: folder.name,
                path: path.join(parentFolderPath, folder.fullPath),
                parent_id: parentId,
                userId,
                ...workspacePatch
            });

            await newFolder.save();
            folderCache.set(folder.fullPath, newFolder);
        }

        // Step 4: Create files with correct parent folders
        const filePromises = files.map(async file => {
            let parentId = parentFolderId;

            if (file.parent) {
                const parentFolder = folderCache.get(file.parent);
                if (parentFolder) {
                    parentId = parentFolder._id;
                }
            }
            
            const fullPath = path.join(parentFolderPath, file.path);
            const absoluteFilePath = path.join(targetDir, file.path);

            // Only create file if it doesn't exist
            const existingFile = await File.findOne({ path: fullPath, ...scopedQuery, deleted: false });
            if (!existingFile) {
                const stats = fs.statSync(absoluteFilePath);
                const mimeType = mime.getType(file.path) || 'application/octet-stream';

                console.log(`Creating file`, file.name);

                if (StorageService.isObjectStorage()) {
                    const savedFile = await this.saveFileMetadata(
                        absoluteFilePath,
                        userId,
                        file.name,
                        parentId,
                        path.dirname(fullPath),
                        { workspaceContext }
                    );
                    savedFile.mimetype = mimeType;
                    savedFile.size = stats.size;
                    await savedFile.save();
                    return savedFile;
                }

                    return {
                        name: file.name,
                        path: fullPath,
                        parent_id: parentId,
                        size: stats.size,
                        mimetype: mimeType,
                        userId,
                        ...workspacePatch,
                        scanStatus: 'clean',
                        storageProvider: StorageService.providerName,
                        bucket: StorageService.bucket,
                        storageKey: fullPath
                    };
            }
            return null;
        });

        // Save files in batches of 100
        const batchSize = 100;
        for (let i = 0; i < filePromises.length; i += batchSize) {
            const batch = filePromises.slice(i, i + batchSize);
            const files = (await Promise.all(batch)).filter(file => file !== null);
            if (files.length > 0 && !StorageService.isObjectStorage()) {
                console.log(files);
                await File.insertMany(files);
                StorageInsightsService.invalidateUser(this.getStorageInsightKey(workspaceContext, userId));
            }
        }

        // Step 5: Recalculate folder sizes
        const allFolderIds = Array.from(folderCache.values()).map(f => f._id);
        if (parentFolderId) {
            allFolderIds.push(parentFolderId);
        }

        // Recalculate sizes for all folders from bottom up
        const sortedForSizes = allFolderIds.sort((a, b) => {
            const folderA = Array.from(folderCache.values()).find(f => f._id.equals(a));
            const folderB = Array.from(folderCache.values()).find(f => f._id.equals(b));
            return (folderB?.path.split('/').length || 0) - (folderA?.path.split('/').length || 0);
        });

        for (const folderId of sortedForSizes) {
            await this.recalculateFolderStats(folderId);
        }

        StorageInsightsService.invalidateUser(this.getStorageInsightKey(workspaceContext, userId));

        if (StorageService.isObjectStorage()) {
            await fs.remove(decompressionTempRoot);
            return parentFolderPath;
        }

        return path.relative(this.uploadDirectory, targetDir);
    }

    static async saveFileMetadata(targetPath, userId, filename, parentId, relativeUploadDir, options = {}) {
        const workspaceContext = await this.getWorkspaceContextFromOptions(userId, options);
        const workspacePatch = this.getWorkspaceItemPatch(workspaceContext, userId);

        if (!parentId) {
            parentId = null;
        }

        if (!relativeUploadDir) {
            relativeUploadDir = workspaceContext.workspace.rootPath;
        }

        const hasExplicitScanStatus = Object.prototype.hasOwnProperty.call(options, 'scanStatus');
        const scanStatus = hasExplicitScanStatus
            ? options.scanStatus
            : (options.requiresVirusScan && config.virusScanning?.enabled ? 'pending' : 'clean');

        const stats = await fs.stat(targetPath);
        const mimeType = mime.getType(targetPath);
        const file = new File({
            userId,
            ...workspacePatch,
            name: filename,
            parent_id: parentId,
            path: this.getLogicalFilePath(workspaceContext.workspace.rootPath, relativeUploadDir, filename),
            size: stats.size,
            mimetype: mimeType,
            createdAt: new Date(),
            deleted: false,
            scanStatus,
            storageProvider: StorageService.providerName,
            bucket: StorageService.bucket
        });

        file.storageKey = StorageService.isObjectStorage()
            ? StorageService.buildFileKey(workspaceContext.workspace._id.toString(), file._id.toString())
            : file.path;

        if (StorageService.isObjectStorage()) {
            await StorageService.uploadFile(file, targetPath, {
                'Content-Type': mimeType || 'application/octet-stream',
                'Original-Name': filename
            });
            await fs.remove(targetPath);
        }

        await file.save();
        StorageInsightsService.invalidateUser(this.getStorageInsightKey(workspaceContext, userId));

        return file;
    }

    static async stopCompression(userId, zipFileName) {
        const key = `${userId}-${zipFileName}`;
        const compression = this.ongoingCompressions.get(key);

        if (compression) {
            const { abortController, activeArchive, output } = compression;

            try {
                // Kill the compression process first
                const killed = CompressionService.killCurrentProcess();
                console.log('Compression process killed:', killed);

                if (activeArchive) {
                    activeArchive.abort(); // Stop the archiver process
                }

                if (output) {
                    output.destroy(); // Close the output stream
                }

                if (abortController) {
                    abortController.abort(); // Signal other components to stop
                }

                // Delete the partial zip file if it exists
                const zipFilePath = path.join(this.uploadDirectory, userId, zipFileName);
                if (fs.existsSync(zipFilePath)) {
                    await fs.unlink(zipFilePath);
                }

                this.ongoingCompressions.delete(key);
                console.log(`Stopped compression for ${zipFileName}.`);
                return true;
            } catch (error) {
                console.error(`Error stopping compression for ${zipFileName}:`, error);
                throw error;
            }
        }

        console.log(`No ongoing compression found for ${zipFileName}.`);
        return false;
    }

    static async updateFolderSize(folderId) {
        if (StorageService.isObjectStorage()) {
            return this.recalculateFolderStats(folderId);
        }

        const folder = await Folder.findById(folderId);
        if (!folder) return;

        const folderPath = path.join(this.uploadDirectory, folder.path);
        if (fs.existsSync(folderPath)) {
            const size = this.calculateFolderSize(folderPath);
            await Folder.updateOne({ _id: folderId }, { size });

            // Update parent folder sizes recursively
            if (folder.parent_id) {
                await this.updateFolderSize(folder.parent_id);
            }
        }
    }

    static async renameItem(userId, itemId, newName, isFolder, options = {}) {
        if (!userId || !itemId || !newName) {
            throw new Error('userId, itemId, and newName are required');
        }
        const workspaceContext = await this.getWorkspaceContextFromOptions(userId, {
            ...options,
            requireWrite: true
        });
        const scopedQuery = this.getScopedItemQuery(workspaceContext);

        if (newName.indexOf('..') > -1) {
            throw new Error('Invalid target folder. Directory traversal is not allowed.');
        }

        if (newName !== path.basename(newName)) {
            throw new Error('Invalid name. Nested paths are not allowed.');
        }

        let item, oldPath, newPath;

        if (isFolder) {
            // Find the folder by ID
            item = await Folder.findOne({ _id: itemId, ...scopedQuery, deleted: false });
            if (!item) throw new Error('Folder not found or access denied');
            this.assertNotPrivateVaultRoot(item, 'renamed');
            await this.assertUnlockedItemAndAncestors(userId, item, workspaceContext);

            // Set old and new paths for renaming
            oldPath = item.path;
            newPath = path.join(path.dirname(oldPath), newName);

            if (!StorageService.isObjectStorage()) {
                fs.renameSync(
                    path.join(this.uploadDirectory, oldPath),
                    path.join(this.uploadDirectory, newPath)
                );
            }

            // Update the folder's own path in the database
            item.name = newName;
            item.path = newPath;
            await item.save();

            // Update all child folders and files with paths that start with the old path
            const oldPathSegment = oldPath;
            const newPathSegment = newPath;
            const childPathRegex = new RegExp(`^${this.escapeRegExp(oldPathSegment)}/`);

            // Find and update child folders
            const childFolders = await Folder.find({
                ...scopedQuery,
                deleted: false,
                path: childPathRegex
            });
            const updateFolderPromises = childFolders.map(folder => {
                folder.path = folder.path.replace(oldPathSegment, newPathSegment);
                return folder.save();
            });

            // Find and update child files
            const childFiles = await File.find({
                ...scopedQuery,
                deleted: false,
                path: childPathRegex
            });
            const updateFilePromises = childFiles.map(file => {
                file.path = file.path.replace(oldPathSegment, newPathSegment);
                if (!StorageService.isObjectStorage()) {
                    file.storageKey = file.path;
                }
                return file.save();
            });

            // Execute updates in parallel
            await Promise.all([...updateFolderPromises, ...updateFilePromises]);

        } else {
            // Find the file by ID
            item = await File.findOne({ _id: itemId, ...scopedQuery, deleted: false });
            if (!item) throw new Error('File not found or access denied');
            await this.assertUnlockedItemAndAncestors(userId, item, workspaceContext);

            // Set old and new paths for renaming
            oldPath = item.path;
            newPath = path.join(path.dirname(oldPath), newName);

            if (!StorageService.isObjectStorage()) {
                fs.renameSync(
                    path.join(this.uploadDirectory, oldPath),
                    path.join(this.uploadDirectory, newPath)
                );
                item.storageKey = newPath;
            }

            // Update the file's name and path in the database
            item.name = newName;
            item.path = newPath;
            await item.save();
        }

        StorageInsightsService.invalidateUser(this.getStorageInsightKey(workspaceContext, userId));

        return `${isFolder ? 'Folder' : 'File'} renamed successfully`;
    }

    static async moveItems(userId, itemIds, targetFolderId, progressCallback, options = {}) {
        const workspaceContext = await this.getWorkspaceContextFromOptions(userId, {
            ...options,
            requireWrite: true
        });
        const workspace = workspaceContext.workspace;
        const scopedQuery = this.getScopedItemQuery(workspaceContext);
        let targetFolder;

        // Validate the target folder
        if (!targetFolderId || targetFolderId === 'root') {
            targetFolder = {path: workspace.rootPath};
        } else {
            targetFolder = await this.assertUnlockedFolderPath(userId, targetFolderId, workspaceContext);
        }

        const totalItems = itemIds.length;
        let processedItems = 0;

        for (const itemId of itemIds) {
            // Find the item to move (file or folder)
            let item = await File.findOne({ _id: itemId, ...scopedQuery, deleted: false }) ||
                await Folder.findOne({ _id: itemId, ...scopedQuery, deleted: false });
            if (!item) {
                console.warn(`Item with ID ${itemId} not found. Skipping.`);
                continue;
            }
            this.assertNotPrivateVaultRoot(item, 'moved');
            await this.assertUnlockedItemAndAncestors(userId, item, workspaceContext);

            // Define old and new paths
            const oldPath = item.path;
            const newPath = path.join(targetFolder.path, item.name);

            if (!StorageService.isObjectStorage()) {
                await fs.move(
                    path.join(this.uploadDirectory, oldPath),
                    path.join(this.uploadDirectory, newPath),
                    {overwrite: false}
                );
                item.storageKey = newPath;
            }

            // Update item's `parent_id` and `path` in the database
            item.parent_id = targetFolderId === 'root' ? null : targetFolderId;
            item.path = newPath;
            await item.save();

            // If the item is a folder, update the paths of all child items
            if (item instanceof Folder) {
                const oldPathSegment = oldPath;
                const newPathSegment = newPath;

                // Update paths of child folders
                const childFolders = await Folder.find({...scopedQuery, path: new RegExp(`^${oldPathSegment}/`)});
                for (const childFolder of childFolders) {
                    childFolder.path = childFolder.path.replace(oldPathSegment, newPathSegment);
                    await childFolder.save();
                }

                // Update paths of child files
                const childFiles = await File.find({...scopedQuery, path: new RegExp(`^${oldPathSegment}/`)});
                for (const childFile of childFiles) {
                    childFile.path = childFile.path.replace(oldPathSegment, newPathSegment);
                    if (!StorageService.isObjectStorage()) {
                        childFile.storageKey = childFile.path;
                    }
                    await childFile.save();
                }
            }

            processedItems++;

            if (progressCallback && typeof progressCallback === 'function') {
                const progress = Math.round((processedItems / totalItems) * 100);
                progressCallback(item.name, progress);
            }

            console.log(`Moved item: ${item.name}`);
        }

        // Recalculate stats for the target folder
        await this.recalculateFolderStats(targetFolderId);
        StorageInsightsService.invalidateUser(this.getStorageInsightKey(workspaceContext, userId));

        return {message: 'Items moved successfully'};
    }

    static async moveItemsIntoZip(userId, itemIds, zipFileId, options = {}) {
        const workspaceContext = await this.getWorkspaceContextFromOptions(userId, {
            ...options,
            requireWrite: true
        });
        const scopedQuery = this.getScopedItemQuery(workspaceContext);
        const zipTempRoot = this.getTempPath('zip-move', userId, `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);

        try {
            const zipFile = await File.findOne({ _id: zipFileId, ...scopedQuery, deleted: false });
            if (!zipFile || zipFile.mimetype !== 'application/zip') {
                throw new Error('Target file is not a valid ZIP file.');
            }
            await this.assertUnlockedItemAndAncestors(userId, zipFile, workspaceContext);

            const zipFilePath = StorageService.isObjectStorage()
                ? await StorageService.materializeFile(zipFile, path.join(zipTempRoot, 'archive', zipFile.name))
                : path.join(this.uploadDirectory, zipFile.path);
            const tmpZipFilePath = `${zipFilePath}.tmp`;

            const output = fs.createWriteStream(tmpZipFilePath);
            const archive = archiver('zip', { zlib: { level: 9 } });

            archive.pipe(output);

            console.log('Reading existing ZIP contents...');
            const existingZip = new AdmZip(zipFilePath);
            const existingEntries = existingZip.getEntries();

            for (const entry of existingEntries) {
                if (!entry.isDirectory) {
                    console.log(`Adding existing ZIP entry: ${entry.entryName}`);
                    archive.append(existingZip.readFile(entry), { name: entry.entryName });
                }
            }

            for (const itemId of itemIds) {
                const item = await File.findOne({ _id: itemId, ...scopedQuery, deleted: false })
                    || await Folder.findOne({ _id: itemId, ...scopedQuery, deleted: false });

                if (!item) {
                    console.warn(`Item with ID ${itemId} not found. Skipping.`);
                    continue;
                }
                this.assertNotPrivateVaultRoot(item, 'moved');
                await this.assertUnlockedItemAndAncestors(userId, item, workspaceContext);

                const itemPath = StorageService.isObjectStorage()
                    ? item instanceof Folder
                        ? await this.materializeFolder(item, path.join(zipTempRoot, 'items', item._id.toString(), item.name))
                        : await StorageService.materializeFile(item, path.join(zipTempRoot, 'items', item._id.toString(), item.name))
                    : path.join(this.uploadDirectory, item.path);

                if (!fs.existsSync(itemPath)) {
                    console.warn(`Item path ${itemPath} does not exist. Skipping.`);
                    continue;
                }

                if (fs.statSync(itemPath).isDirectory()) {
                    console.log(`Adding folder to ZIP: ${item.name}`);
                    await this.addFolderToArchive(archive, itemPath, item.name);
                    await this.deleteFolderAndContents(itemId, workspaceContext);
                } else {
                    console.log(`Streaming file to ZIP: ${item.name}`);
                    try {
                        const fileStream = fs.createReadStream(itemPath);
                        archive.append(fileStream, { name: item.name });
                        console.log(`File successfully queued: ${item.name}`);

                        await StorageService.deleteFile(item);
                        await File.updateOne({ _id: item._id }, { $set: { deleted: true } });
                    } catch (err) {
                        console.error(`Error adding file to ZIP: ${err.message}`);
                    }
                }
            }

            console.log('Finalizing archive...');
            await this.finalizeArchiveWithTimeout(archive, 30000); // 30-second timeout

            console.log('Replacing original ZIP file...');
            fs.renameSync(tmpZipFilePath, zipFilePath);

            if (StorageService.isObjectStorage()) {
                await StorageService.uploadFile(zipFile, zipFilePath, {
                    'Content-Type': zipFile.mimetype || 'application/zip',
                    'Original-Name': zipFile.name
                });
                const stats = fs.statSync(zipFilePath);
                zipFile.size = stats.size;
                await zipFile.save();
                await fs.remove(zipTempRoot);
            }

            StorageInsightsService.invalidateUser(this.getStorageInsightKey(workspaceContext, userId));

            return { message: 'Items moved into ZIP file successfully' };
        } catch (error) {
            if (StorageService.isObjectStorage()) {
                await fs.remove(zipTempRoot);
            }
            console.error('Error moving items into ZIP file:', error.message);
            throw new Error('Failed to move items into ZIP file');
        }
    }

    // Helper Method: Add Folder and Its Contents to Archive
    static async addFolderToArchive(archive, folderPath, folderName) {
        const items = fs.readdirSync(folderPath);

        for (const item of items) {
            const itemPath = path.join(folderPath, item);

            if (!fs.existsSync(itemPath)) {
                console.warn(`Sub-item path ${itemPath} does not exist. Skipping.`);
                continue;
            }

            if (fs.statSync(itemPath).isDirectory()) {
                console.log(`Adding subfolder to ZIP: ${path.join(folderName, item)}`);
                await this.addFolderToArchive(archive, itemPath, path.join(folderName, item));
            } else {
                console.log(`Streaming file to ZIP: ${path.join(folderName, item)}`);
                try {
                    const fileStream = fs.createReadStream(itemPath);
                    archive.append(fileStream, { name: path.join(folderName, item) });
                } catch (err) {
                    console.error(`Error adding file to ZIP: ${err.message}`);
                }
            }
        }
    }

    // Helper Method: Finalize Archive with Timeout
    static async finalizeArchiveWithTimeout(archive, timeout) {
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                console.error('Finalization timeout exceeded.');
                reject(new Error('Archive finalization timed out.'));
            }, timeout);

            archive.on('error', (err) => {
                clearTimeout(timeoutId);
                console.error('Error during finalization:', err);
                reject(err);
            });

            archive.finalize().then(() => {
                clearTimeout(timeoutId);
                console.log('Archive finalized successfully.');
                resolve();
            }).catch((err) => {
                clearTimeout(timeoutId);
                console.error('Finalization failed:', err);
                reject(err);
            });
        });
    }

    // Helper Method: Delete Folder and Its Contents
    static async deleteFolderAndContents(folderId, workspaceContext = null) {
        const scope = workspaceContext && workspaceContext.workspace
            ? { workspaceId: workspaceContext.workspace._id.toString() }
            : {};
        const folder = await Folder.findOne({ _id: folderId, ...scope, deleted: false });
        if (!folder) return;

        // Get all files and subfolders inside the folder
        const files = await File.find({ parent_id: folderId, ...scope, deleted: false });
        const subfolders = await Folder.find({ parent_id: folderId, ...scope, deleted: false });

        // Delete all files in the folder
        for (const file of files) {
            await StorageService.deleteFile(file);
            await File.deleteOne({ _id: file._id });
        }

        // Recursively delete all subfolders
        for (const subfolder of subfolders) {
            await this.deleteFolderAndContents(subfolder._id, workspaceContext);
        }

        if (!StorageService.isObjectStorage()) {
            const folderPath = path.join(this.uploadDirectory, folder.path);
            if (fs.existsSync(folderPath)) {
                fs.rmSync(folderPath, { recursive: true, force: true });
            }
        }
        await Folder.deleteOne({ _id: folderId });
    }

    static async getFileStream(fileOrPath, options = {}) {
        try {
            if (typeof fileOrPath === 'string') {
                await fs.access(fileOrPath);

                return {
                    stream: fs.createReadStream(fileOrPath, options),
                    mimetype: mime.getType(fileOrPath)
                };
            }

            const stream = await StorageService.createReadStream(fileOrPath, options);
            return {
                stream,
                mimetype: fileOrPath.mimetype || mime.getType(fileOrPath.name)
            };
        } catch (error) {
            throw new Error('File not found or inaccessible');
        }
    }

    static async getDownloadFile(userId, fileRef = {}) {
        const reference = typeof fileRef === 'string' ? { filePath: fileRef } : fileRef || {};
        const fileId = reference.fileId || reference.id || null;
        const filePath = reference.filePath || reference.path || null;

        const file = fileId
            ? await this.getAccessibleFileById(userId, fileId)
            : await File.findOne({
                path: filePath,
                deleted: false
            });

        if (!file || !await this.canAccessFile(userId, file)) {
            throw new Error('File does not exist.');
        }

        if (!await this.canDownloadFile(userId, file)) {
            throw new Error('Download access denied');
        }

        await this.assertSharedFileReadyForAccess(file, userId);
        const workspaceContext = this.getWorkspaceContextFromItem(file);
        await this.assertUnlockedItemAndAncestors(userId, file, workspaceContext);

        return file;
    }

    static async prepareDownload(userId, fileRef, offset = 0, chunkSize = 1024 * 1024, options = {}) {
        const file = await this.getDownloadFile(userId, fileRef);
        const fileSize = file.size || await this.getStoredFileSize(file);
        const start = Math.max(0, offset);
        const end = Math.min(start + chunkSize - 1, fileSize - 1);

        if (options.trackDownload === true && start === 0) {
            await this.recordDownloadAccess(userId, file);
        }

        return {
            file,
            fileSize,
            start,
            end,
            contentLength: end >= start ? end - start + 1 : 0,
            stream: end >= start ? (await this.getFileStream(file, { start, end })).stream : null
        };
    }

    static async getStoredFileSizeByPath(userId, fileRef) {
        const file = await this.getDownloadFile(userId, fileRef);
        return file.size || await this.getStoredFileSize(file);
    }

    static async processChunkAndTrackProgress(userId, filename, folderId, chunk, currentChunk, totalChunks, fileSize = null, options = {}) {
        try {
            const workspaceContext = await this.getWorkspaceContextFromOptions(userId, {
                ...options,
                requireWrite: true
            });
            const normalizedFolderId = this.normalizeFolderId(folderId);
            const normalizedCurrentChunk = parseInt(currentChunk, 10);
            const normalizedTotalChunks = parseInt(totalChunks, 10);
            const normalizedFileSize = fileSize != null ? parseInt(fileSize, 10) : null;
            const progressFilter = this.getUploadProgressFilter(userId, filename, normalizedFolderId, workspaceContext);

            let uploadProgress = await UploadProgress.findOne(progressFilter);

            if (!uploadProgress && normalizedCurrentChunk === 1) {
                await this.cleanupPartialUpload(userId, filename, normalizedFolderId, { workspaceContext });
            }

            if (uploadProgress) {
                const hasMetadataMismatch =
                    (Number.isInteger(normalizedTotalChunks) && uploadProgress.totalChunks && uploadProgress.totalChunks !== normalizedTotalChunks) ||
                    (Number.isInteger(normalizedFileSize) && uploadProgress.fileSize && uploadProgress.fileSize !== normalizedFileSize);

                if (hasMetadataMismatch) {
                    await this.cleanupPartialUpload(userId, filename, normalizedFolderId, { workspaceContext });
                    uploadProgress = null;
                }
            }

            // Process the uploaded chunk (store to disk or database)
            const file = await this.uploadFile(
                userId,
                filename,
                normalizedFolderId,
                chunk,
                normalizedCurrentChunk,
                normalizedTotalChunks,
                { workspaceContext }
            );

            // Track uploaded chunk progress
            const chunkIndex = normalizedCurrentChunk;

            if (!uploadProgress) {
                uploadProgress = new UploadProgress({
                    ...progressFilter,
                    workspaceType: workspaceContext.workspace.type,
                    organizationId: workspaceContext.workspace.organizationId || null,
                    fileSize: Number.isInteger(normalizedFileSize) ? normalizedFileSize : null,
                    totalChunks: Number.isInteger(normalizedTotalChunks) ? normalizedTotalChunks : null,
                    uploadedChunks: []
                });
            }

            if (!uploadProgress.uploadedChunks.includes(chunkIndex)) {
                uploadProgress.uploadedChunks.push(chunkIndex);
                uploadProgress.uploadedChunks.sort((a, b) => a - b);
                await uploadProgress.save();
            }

            if (normalizedCurrentChunk >= normalizedTotalChunks) {
                await uploadProgress.deleteOne();
            }

            return file;
        } catch (error) {
            if (error.message.includes('Virus detected')) {
                // Clean up any partially uploaded chunks
                await this.cleanupPartialUpload(userId, filename, folderId, options);
                throw new Error('File rejected: Virus detected');
            }
            throw error;
        }
    }

    static async cleanupPartialUpload(userId, filename, folderId = null, options = {}) {
        try {
            const workspaceContext = await this.getWorkspaceContextFromOptions(userId, options);
            const normalizedFolderId = this.normalizeFolderId(folderId);
            const progressFilter = this.getUploadProgressFilter(userId, filename, normalizedFolderId, workspaceContext);
            const uploadProgress = await UploadProgress.findOne(progressFilter);
            if (uploadProgress) {
                await uploadProgress.deleteOne();
            }

            try {
                const { uploadDir } = await this.resolveUploadTarget(userId, normalizedFolderId, { workspaceContext });
                const chunkDir = this.getChunkDir(uploadDir, filename);
                if (fs.existsSync(chunkDir)) {
                    await fs.remove(chunkDir);
                }
            } catch (resolveError) {
                // Folder may have been deleted; the database cleanup above is still useful.
            }
        } catch (error) {
            console.error('Error cleaning up partial upload:', error);
        }
    }

    static async getUploadedChunks(filename, userId, folderId = null, totalChunks = null, fileSize = null, options = {}) {
        try {
            const workspaceContext = await this.getWorkspaceContextFromOptions(userId, options);
            const normalizedFolderId = this.normalizeFolderId(folderId);
            const progressFilter = this.getUploadProgressFilter(userId, filename, normalizedFolderId, workspaceContext);
            const uploadProgress = await UploadProgress.findOne(progressFilter);

            if (!uploadProgress) {
                return null; // No progress found for the file
            }

            const normalizedTotalChunks = totalChunks != null ? parseInt(totalChunks, 10) : null;
            const normalizedFileSize = fileSize != null ? parseInt(fileSize, 10) : null;
            const hasMetadataMismatch =
                (Number.isInteger(normalizedTotalChunks) && uploadProgress.totalChunks && uploadProgress.totalChunks !== normalizedTotalChunks) ||
                (Number.isInteger(normalizedFileSize) && uploadProgress.fileSize && uploadProgress.fileSize !== normalizedFileSize);

            if (hasMetadataMismatch) {
                await this.cleanupPartialUpload(userId, filename, normalizedFolderId, { workspaceContext });
                return null;
            }

            let uploadDir;
            try {
                ({ uploadDir } = await this.resolveUploadTarget(userId, normalizedFolderId, { workspaceContext }));
            } catch (resolveError) {
                await this.cleanupPartialUpload(userId, filename, normalizedFolderId, { workspaceContext });
                return null;
            }
            const chunkDir = this.getChunkDir(uploadDir, filename);
            const chunkNumbers = this.getChunkNumbers(chunkDir);

            if (chunkNumbers.length === 0) {
                await this.cleanupPartialUpload(userId, filename, normalizedFolderId, { workspaceContext });
                return null;
            }

            const recordedChunks = new Set(uploadProgress.uploadedChunks || []);
            const actualChunks = new Set(chunkNumbers);
            const contiguousChunks = [];
            const maxExpectedChunk = Number.isInteger(normalizedTotalChunks)
                ? normalizedTotalChunks
                : Math.max(...chunkNumbers);

            for (let chunkIndex = 1; chunkIndex <= maxExpectedChunk; chunkIndex += 1) {
                if (recordedChunks.has(chunkIndex) && actualChunks.has(chunkIndex)) {
                    contiguousChunks.push(chunkIndex);
                    continue;
                }

                break;
            }

            if (contiguousChunks.length === 0) {
                await this.cleanupPartialUpload(userId, filename, normalizedFolderId, { workspaceContext });
                return null;
            }

            if (contiguousChunks.length !== uploadProgress.uploadedChunks.length) {
                uploadProgress.uploadedChunks = contiguousChunks;
                await uploadProgress.save();
            }

            return contiguousChunks; // Return the list of uploaded chunks
        } catch (error) {
            console.error('Error retrieving uploaded chunks:', error.message);
            throw new Error('Failed to retrieve upload progress.');
        }
    }

    static async getFolderTree(userId, parentId = null, isRoot = true, options = {}) {
        try {
            const workspaceContext = await this.getWorkspaceContextFromOptions(userId, options);
            const scopedQuery = this.getScopedItemQuery(workspaceContext);
            if (parentId === 'root') {
                parentId = null;
                isRoot = true;
            }

            if (parentId) {
                await this.assertUnlockedFolderPath(userId, parentId, workspaceContext);
            }

            // Fetch folders for the current parent
            const folders = await Folder.find({ ...scopedQuery, parent_id: parentId, deleted: false }).lean();

            // Construct the tree for each folder
            const tree = await Promise.all(folders.map(async (folder) => {
                const isLocked = folder.isPasswordProtected && !this.hasValidRecentAccess(folder, userId);
                // Only check for subfolders in tree mode
                const subfolderCount = await Folder.countDocuments({ 
                    ...scopedQuery,
                    parent_id: folder._id.toString(), 
                    deleted: false 
                });

                const children = isLocked
                    ? []
                    : await this.getFolderTree(userId, folder._id, false, { workspaceContext }); // Recursive call to get child folders
                return {
                    id: folder._id,
                    text: folder.name,
                    iconCls: folder.isPrivateVaultRoot === true ? 'fa fa-user-lock' : 'fa fa-solid fa-folder',
                    expanded: false,
                    children: children.length > 0 ? children : [],
                    parentId: folder.parent_id,
                    isLocked,
                    isPrivateVaultRoot: folder.isPrivateVaultRoot === true,
                    leaf: isLocked || subfolderCount === 0 // Leaf if no subfolders, or locked
                };
            }));

            return tree;
        } catch (error) {
            console.error('Error in getFolderTree:', error.message);
            throw new Error('Failed to construct folder tree');
        }
    }

    static async shareItem(userId, itemId, isFolder, recipient, permission = 'download', expiryOptions = {}) {
        if (!itemId || !recipient) {
            throw new Error('Item and recipient are required');
        }

        const normalizedPermission = ['view', 'download'].includes(permission) ? permission : 'download';
        const expiresAt = this.getExpiryDate(expiryOptions);
        const Model = isFolder ? Folder : File;
        const workspaceContext = await this.getWorkspaceContextFromOptions(userId, {
            workspaceId: expiryOptions.workspaceId || null
        });
        const item = await Model.findOne({
            _id: itemId,
            ...this.getScopedItemQuery(workspaceContext),
            deleted: false
        });

        if (!item) {
            throw new Error('Item not found or access denied');
        }
        await this.assertNotInsidePrivateVault(item, workspaceContext);

        const governedShare = workspaceContext.workspace.type === 'organization'
            ? await OrganizationShareService.createShare(userId, workspaceContext.workspace.organizationId, {
                itemId,
                itemType: isFolder ? 'folder' : 'file',
                targetType: 'member',
                targetIdentifier: recipient,
                permission: normalizedPermission,
                expiresInHours: expiryOptions.expiresInHours,
                expiresInMinutes: expiryOptions.expiresInMinutes
            })
            : null;

        if (governedShare) {
            return {
                id: governedShare.id,
                itemId: item._id.toString(),
                itemType: isFolder ? 'folder' : 'file',
                itemName: item.name,
                permission: governedShare.permission,
                permissions: governedShare.permissions,
                expiresAt: governedShare.expiresAt,
                targetType: governedShare.targetType,
                recipient: {
                    id: governedShare.recipientId,
                    username: governedShare.targetLabel || recipient,
                    email: governedShare.targetLabel || ''
                }
            };
        }

        const recipientUser = await User.findOne({
            $or: [
                { username: recipient },
                { email: recipient }
            ]
        }).select('_id username email');

        if (!recipientUser) {
            throw new Error('Recipient user not found');
        }

        if (recipientUser._id.toString() === userId.toString()) {
            throw new Error('You cannot share an item with yourself');
        }

        const share = await Share.findOneAndUpdate(
            {
                ownerId: userId.toString(),
                workspaceId: item.workspaceId || null,
                recipientId: recipientUser._id.toString(),
                itemId: item._id.toString(),
                itemType: isFolder ? 'folder' : 'file'
            },
            {
                ownerId: userId.toString(),
                workspaceId: item.workspaceId || null,
                workspaceType: item.workspaceType || null,
                organizationId: item.organizationId || null,
                recipientId: recipientUser._id.toString(),
                itemId: item._id.toString(),
                itemType: isFolder ? 'folder' : 'file',
                permission: normalizedPermission,
                revoked: false,
                expiresAt
            },
            {
                upsert: true,
                new: true,
                setDefaultsOnInsert: true
            }
        );

        await ActivityEventService.recordShareCreated({
            actorUserId: userId,
            ownerId: userId,
            recipientId: recipientUser._id.toString(),
            targetType: 'member',
            targetLabel: recipientUser.username || recipientUser.email || recipient,
            item,
            itemType: isFolder ? 'folder' : 'file',
            shareId: share._id.toString(),
            permission: share.permission,
            expiresAt: share.expiresAt
        }).catch(error => {
            console.error('Failed to record share activity:', error.message);
        });

        return {
            id: share._id.toString(),
            itemId: item._id.toString(),
            itemType: isFolder ? 'folder' : 'file',
            itemName: item.name,
            permission: share.permission,
            expiresAt: share.expiresAt,
            recipient: {
                id: recipientUser._id.toString(),
                username: recipientUser.username,
                email: recipientUser.email
            }
        };
    }

    static async revokeShare(userId, shareId) {
        const share = await Share.findOne({
            _id: shareId,
            ownerId: userId.toString(),
            revoked: false
        });

        if (!share) {
            throw new Error('Share not found');
        }

        share.revoked = true;
        await share.save();

        const Model = share.itemType === 'folder' ? Folder : File;
        const item = await Model.findOne({
            _id: share.itemId,
            userId: userId.toString()
        }).lean();

        if (item) {
            await ActivityEventService.recordShareRevoked({
                actorUserId: userId,
                ownerId: userId,
                recipientId: share.recipientId,
                targetType: share.targetType || 'member',
                targetLabel: share.targetLabel || 'recipient',
                item,
                itemType: share.itemType,
                shareId: share._id.toString()
            }).catch(error => {
                console.error('Failed to record share revocation activity:', error.message);
            });
        }

        return { success: true };
    }

    static async revokeItemShares(userId, itemId, isFolder, options = {}) {
        const itemType = isFolder ? 'folder' : 'file';
        const Model = isFolder ? Folder : File;
        const workspaceContext = await this.getWorkspaceContextFromOptions(userId, options);
        const item = await Model.findOne({
            _id: itemId,
            userId: userId.toString(),
            ...this.getScopedItemQuery(workspaceContext),
            deleted: false
        });

        if (!item) {
            throw new Error('Item not found or access denied');
        }

        const shareFilter = this.getActiveOutgoingShareFilter(userId, {
            itemId: item._id.toString(),
            itemType,
            workspaceId: item.workspaceId || null
        });
        const shares = await Share.find(shareFilter).lean();
        const result = await Share.updateMany(
            shareFilter,
            {
                $set: {
                    revoked: true
                }
            }
        );

        await Promise.all(shares.map(share => ActivityEventService.recordShareRevoked({
            actorUserId: userId,
            ownerId: userId,
            recipientId: share.targetType === 'member' || !share.targetType ? share.recipientId : null,
            targetType: share.targetType || 'member',
            targetLabel: share.targetLabel || 'recipient',
            item,
            itemType,
            shareId: share._id.toString()
        }).catch(error => {
            console.error('Failed to record share revocation activity:', error.message);
        })));

        return {
            success: true,
            revokedCount: result.modifiedCount || result.nModified || 0
        };
    }

    static async setPassword(userId, itemId, password, isFolder) {
        try {
            const Model = isFolder ? Folder : File;
            const item = await Model.findOne({ _id: itemId, userId, deleted: false });

            if (!item) {
                throw new Error('Item not found');
            }
            this.assertNotPrivateVaultRoot(item, 'changed through item password actions');

            // Hash the password before storing
            const hashedPassword = await bcrypt.hash(password, 10);

            item.isPasswordProtected = true;
            item.password = hashedPassword;
            await item.save();

            return { success: true };
        } catch (error) {
            console.error('Error setting password:', error.message);
            throw error;
        }
    }

    static async removePassword(userId, itemId, currentPassword, isFolder) {
        try {
            const Model = isFolder ? Folder : File;
            const item = await Model.findOne({ _id: itemId, userId, deleted: false }).select('+password');

            if (!item) {
                throw new Error('Item not found');
            }
            this.assertNotPrivateVaultRoot(item, 'unlocked permanently');

            const isMatch = await bcrypt.compare(currentPassword, item.password);
            if (!isMatch) {
                throw new Error('Invalid password');
            }

            item.isPasswordProtected = false;
            item.password = undefined;
            item.isPasswordProtected = false; // Reset canRemovePassword after removing password
            await item.save();

            return { success: true };
        } catch (error) {
            console.error('Error removing password:', error.message);
            throw error;
        }
    }

    static async verifyPassword(userId, itemId, password, isFolder) {
        if (!itemId || !password) {
            return false;
        }

        try {
            if (isFolder) {
                const folder = await Folder.findOne({ _id: itemId, deleted: false }).select('+password');
                if (!folder || !folder.isPasswordProtected || !await this.canAccessFolder(userId, folder)) {
                    return false;
                }
                
                const isValid = await bcrypt.compare(password, folder.password);
                if (!isValid) {
                    return false;
                }
                
                this.grantPasswordAccess(folder, userId);
                await folder.save();
            } else {
                const file = await File.findOne({ _id: itemId, deleted: false }).select('+password');
                if (!file || !file.isPasswordProtected || !await this.canAccessFile(userId, file)) {
                    return false;
                }
                
                const isValid = await bcrypt.compare(password, file.password);
                if (!isValid) {
                    return false;
                }
                
                this.grantPasswordAccess(file, userId);
                await file.save();
            }
            
            return true;
        } catch (error) {
            console.error('Error in verifyPassword:', error);
            return false;
        }
    }

    static async getMimeType(filePath) {
        const mimeType = mime.getType(filePath);
        return { filePath, mimeType };
    }
}

module.exports = FileService;
