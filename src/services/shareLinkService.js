const crypto = require('crypto');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const archiver = require('archiver');
const mime = require('mime');

const File = require('../models/fileModel');
const Folder = require('../models/folderModel');
const ShareLink = require('../models/shareLinkModel');
const StorageService = require('./storage/storageService');
const config = require('../config');
const OrganizationPolicyService = require('./organizationPolicyService');
const ActivityEventService = require('./activityEventService');
const WorkspaceService = require('./workspaceService');
const FileService = require('./fileService');

class PublicShareError extends Error {
    constructor(message, statusCode = 400, code = 'SHARE_ERROR') {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
    }
}

class ShareLinkService {
    static createToken() {
        return crypto.randomBytes(32).toString('base64url');
    }

    static hashToken(token) {
        return crypto.createHash('sha256').update(String(token || '')).digest('hex');
    }

    static normalizePermission(permission) {
        return permission === 'view' ? 'view' : 'download';
    }

    static isPreviewableMimeType(mimeType) {
        const normalized = String(mimeType || '').toLowerCase();

        return normalized.startsWith('image/') ||
            normalized.startsWith('audio/') ||
            normalized.startsWith('video/') ||
            normalized.startsWith('text/') ||
            [
                'application/pdf',
                'application/json',
                'application/xml',
                'application/javascript',
                'application/x-javascript',
                'application/csv'
            ].includes(normalized);
    }

    static getItemModel(itemTypeOrIsFolder) {
        return itemTypeOrIsFolder === true || itemTypeOrIsFolder === 'folder' ? Folder : File;
    }

    static getItemType(itemTypeOrIsFolder) {
        return itemTypeOrIsFolder === true || itemTypeOrIsFolder === 'folder' ? 'folder' : 'file';
    }

    static getExpiryDate(expiresInHours, expiresInMinutes = null) {
        const minutes = Number(expiresInMinutes);
        if (Number.isFinite(minutes) && minutes > 0) {
            return new Date(Date.now() + Math.min(minutes, 365 * 24 * 60) * 60 * 1000);
        }

        const hours = Number(expiresInHours);
        if (!Number.isFinite(hours) || hours <= 0) {
            return null;
        }

        return new Date(Date.now() + Math.min(hours, 24 * 365) * 60 * 60 * 1000);
    }

    static async findOwnedItem(ownerId, itemId, itemTypeOrIsFolder, options = {}) {
        const itemType = this.getItemType(itemTypeOrIsFolder);
        const Model = this.getItemModel(itemType);
        const workspaceContext = await WorkspaceService.assertWorkspaceAccess(ownerId, options.workspaceId || null);
        const item = await Model.findOne({
            _id: itemId,
            userId: ownerId.toString(),
            workspaceId: workspaceContext.workspace._id.toString(),
            deleted: false
        });

        if (!item) {
            throw new PublicShareError('Item not found or access denied', 404, 'ITEM_NOT_FOUND');
        }

        if (itemType === 'file' && item.scanStatus && item.scanStatus !== 'clean') {
            throw new PublicShareError('This file is not available for sharing until virus scan is clean.', 409, 'ITEM_NOT_READY');
        }

        await FileService.assertNotInsidePrivateVault(
            item,
            workspaceContext,
            'Private Vault items cannot be shared through public links.'
        );

        return { item, itemType, workspaceContext };
    }

    static async createLink(ownerId, itemId, isFolder, options = {}) {
        const { item, itemType, workspaceContext } = await this.findOwnedItem(ownerId, itemId, isFolder, options);
        const token = this.createToken();
        const tokenHash = this.hashToken(token);
        const organizationId = workspaceContext.workspace.type === 'organization'
            ? workspaceContext.workspace.organizationId
            : null;
        let maxDownloads = null;

        if (organizationId) {
            const policy = await OrganizationPolicyService.getEffectiveSharingPolicy(ownerId, organizationId);
            maxDownloads = OrganizationPolicyService.getPolicyMaxDownloads(policy);
            if (policy.publicLinkSharingAllowed === false || policy.externalSharingAllowed === false) {
                throw new PublicShareError('Public link sharing is blocked by organization policy.', 403, 'PUBLIC_LINK_BLOCKED');
            }

            if (policy.requireExternalApproval) {
                throw new PublicShareError('Public links cannot be created while external sharing approval is required by organization policy.', 403, 'PUBLIC_LINK_APPROVAL_REQUIRED');
            }

            const linkPermission = this.normalizePermission(options.permission);
            if (!policy.allowedPermissions.includes(linkPermission)) {
                throw new PublicShareError(`The "${linkPermission}" permission is blocked by organization policy.`, 403, 'PERMISSION_BLOCKED');
            }

            const expiresAt = this.getExpiryDate(options.expiresInHours, options.expiresInMinutes);
            if (policy.requireExternalExpiration && !expiresAt) {
                throw new PublicShareError('Public links must have an expiration date by organization policy.', 403, 'PUBLIC_LINK_EXPIRY_REQUIRED');
            }

            options = {
                ...options,
                permission: linkPermission,
                expiresAtOverride: expiresAt
            };
        }

        await ShareLink.updateMany(
            {
                ownerId: ownerId.toString(),
                itemId: item._id.toString(),
                itemType,
                $or: [
                    { workspaceId: workspaceContext.workspace._id.toString() },
                    { workspaceId: { $exists: false } },
                    { workspaceId: null },
                    { workspaceId: '' }
                ],
                revoked: false
            },
            { $set: { revoked: true } }
        );

        const link = await ShareLink.create({
            ownerId: ownerId.toString(),
            workspaceId: workspaceContext.workspace._id.toString(),
            workspaceType: workspaceContext.workspace.type,
            organizationId,
            createdByUserId: ownerId.toString(),
            itemId: item._id.toString(),
            itemType,
            tokenHash,
            tokenPreview: token.slice(0, 8),
            permission: this.normalizePermission(options.permission),
            expiresAt: options.expiresAtOverride || this.getExpiryDate(options.expiresInHours, options.expiresInMinutes),
            maxDownloads
        });

        await ActivityEventService.recordShareCreated({
            actorUserId: ownerId,
            ownerId,
            targetType: 'external',
            targetLabel: 'Anyone with link',
            item,
            itemType,
            shareId: link._id.toString(),
            permission: link.permission,
            expiresAt: link.expiresAt
        }).catch(error => {
            console.error('Failed to record public link activity:', error.message);
        });

        return {
            link,
            token,
            item
        };
    }

    static async revokeItemLinks(ownerId, itemId, itemTypeOrIsFolder, options = {}) {
        const { item, itemType, workspaceContext } = await this.findOwnedItem(ownerId, itemId, itemTypeOrIsFolder, options);
        const result = await ShareLink.updateMany(
            {
                ownerId: ownerId.toString(),
                itemId: item._id.toString(),
                itemType,
                $or: [
                    { workspaceId: workspaceContext.workspace._id.toString() },
                    { workspaceId: { $exists: false } },
                    { workspaceId: null },
                    { workspaceId: '' }
                ],
                revoked: false
            },
            { $set: { revoked: true } }
        );

        if ((result.modifiedCount || result.nModified || 0) > 0) {
            await ActivityEventService.recordShareRevoked({
                actorUserId: ownerId,
                ownerId,
                targetType: 'external',
                targetLabel: 'Anyone with link',
                item,
                itemType,
                relatedEntityId: item._id.toString()
            }).catch(error => {
                console.error('Failed to record public link revocation activity:', error.message);
            });
        }

        return {
            success: true,
            revokedCount: result.modifiedCount || result.nModified || 0
        };
    }

    static async getLinkRecord(token) {
        if (!token) {
            throw new PublicShareError('This link is invalid or missing.', 404, 'INVALID_LINK');
        }

        const link = await ShareLink.findOne({ tokenHash: this.hashToken(token) });
        if (!link) {
            throw new PublicShareError('This link is invalid or no longer exists.', 404, 'INVALID_LINK');
        }

        if (link.revoked) {
            throw new PublicShareError('This link has been invalidated by the owner.', 410, 'LINK_REVOKED');
        }

        if (link.expiresAt && link.expiresAt <= new Date()) {
            throw new PublicShareError('This link has expired.', 410, 'LINK_EXPIRED');
        }

        return link;
    }

    static async getLinkedItem(link, options = {}) {
        const Model = this.getItemModel(link.itemType);
        const query = {
            _id: link.itemId,
            deleted: false
        };

        if (link.workspaceId) {
            query.workspaceId = link.workspaceId;
        } else {
            query.userId = link.ownerId;
        }

        if (options.includePassword) {
            return Model.findOne(query).select('+password');
        }

        return Model.findOne(query);
    }

    static assertFileShareable(file) {
        if (!file || file.deleted) {
            throw new PublicShareError('The shared item is no longer available.', 404, 'ITEM_UNAVAILABLE');
        }

        if (file.scanStatus && file.scanStatus !== 'clean') {
            throw new PublicShareError('The shared file is not available because it is not clean.', 410, 'ITEM_BLOCKED');
        }
    }

    static async prepareFileForPublicAccess(file) {
        if (!file || file.deleted) {
            return {
                available: false,
                statusCode: 404,
                code: 'ITEM_UNAVAILABLE',
                message: 'The shared item is no longer available.'
            };
        }

        if (file.scanStatus === 'infected') {
            return {
                available: false,
                statusCode: 410,
                code: 'ITEM_BLOCKED',
                message: 'The shared file is not available because it failed virus scanning.'
            };
        }

        if (!config.virusScanning?.enabled || file.scanStatus === 'clean') {
            return {
                available: true
            };
        }

        const ScanningService = require('./scanningService');
        await ScanningService.ensureFileScanQueued(file, {
            notifyUserIds: [file.userId.toString()]
        });

        return {
            available: false,
            statusCode: 409,
            code: 'ITEM_NOT_READY',
            message: 'This file is being scanned for viruses and will be available once the scan completes.'
        };
    }

    static createPasswordAccessToken(link, item) {
        return jwt.sign(
            {
                purpose: 'public-share-password',
                linkId: link._id.toString(),
                itemId: item._id.toString(),
                itemType: link.itemType
            },
            process.env.JWT_SECRET,
            { expiresIn: '15m' }
        );
    }

    static hasPasswordAccess(link, item, accessToken) {
        if (!item.isPasswordProtected) {
            return true;
        }

        if (!accessToken) {
            return false;
        }

        try {
            const payload = jwt.verify(accessToken, process.env.JWT_SECRET);
            return payload.purpose === 'public-share-password' &&
                payload.linkId === link._id.toString() &&
                payload.itemId === item._id.toString() &&
                payload.itemType === link.itemType;
        } catch (error) {
            return false;
        }
    }

    static getDownloadCount(link) {
        return Math.max(0, Number(link && link.downloadCount) || 0);
    }

    static async getEffectiveLinkMaxDownloads(link) {
        if (link && link.organizationId) {
            try {
                const policy = await OrganizationPolicyService.getEffectiveSharingPolicy(link.ownerId, link.organizationId);
                return OrganizationPolicyService.getPolicyMaxDownloads(policy);
            } catch (error) {
                throw new PublicShareError('This organization link is not currently available.', 403, 'ORG_LINK_BLOCKED');
            }
        }

        return OrganizationPolicyService.normalizeMaxDownloads(link && link.maxDownloads);
    }

    static async assertDownloadLimitAvailable(link) {
        const maxDownloads = await this.getEffectiveLinkMaxDownloads(link);

        if (maxDownloads !== null && this.getDownloadCount(link) >= maxDownloads) {
            throw new PublicShareError('The download limit for this public link has been reached.', 403, 'DOWNLOAD_LIMIT_REACHED');
        }

        return maxDownloads;
    }

    static async recordDownload(link) {
        if (!link || !link._id) {
            return null;
        }

        const maxDownloads = await this.getEffectiveLinkMaxDownloads(link);
        const filter = {
            _id: link._id,
            revoked: false
        };

        if (maxDownloads !== null) {
            filter.$or = [
                { downloadCount: { $exists: false } },
                { downloadCount: { $lt: maxDownloads } }
            ];
        }

        const updated = await ShareLink.findOneAndUpdate(
            filter,
            {
                $inc: { downloadCount: 1 },
                $set: { lastDownloadedAt: new Date() }
            },
            { new: true }
        );

        if (!updated) {
            throw new PublicShareError('The download limit for this public link has been reached.', 403, 'DOWNLOAD_LIMIT_REACHED');
        }

        link.downloadCount = updated.downloadCount;
        link.lastDownloadedAt = updated.lastDownloadedAt;
        return updated;
    }

    static async resolvePublicShare(token, options = {}) {
        const link = await this.getLinkRecord(token);
        await this.assertLinkAllowedByOrganizationPolicy(link, {
            requireDownload: options.requireDownload === true
        });
        const item = await this.getLinkedItem(link, { includePassword: options.includePassword });

        if (!item || item.deleted) {
            throw new PublicShareError('The shared item is no longer available.', 404, 'ITEM_UNAVAILABLE');
        }

        if (link.itemType === 'file') {
            const availability = await this.prepareFileForPublicAccess(item);
            if (!availability.available) {
                throw new PublicShareError(availability.message, availability.statusCode, availability.code);
            }
        }

        if (options.requireDownload && link.permission !== 'download') {
            throw new PublicShareError('This link is view-only. Downloads are disabled.', 403, 'DOWNLOAD_DISABLED');
        }

        if (options.requirePassword && item.isPasswordProtected && !this.hasPasswordAccess(link, item, options.accessToken)) {
            throw new PublicShareError('Password required to access this item.', 401, 'PASSWORD_REQUIRED');
        }

        if (options.requireDownload) {
            await this.recordDownload(link);
        }

        if (options.markAccessed) {
            link.accessCount += 1;
            link.lastAccessedAt = new Date();
            await link.save();
        }

        return { link, item };
    }

    static async assertLinkAllowedByOrganizationPolicy(link, options = {}) {
        if (!link || !link.organizationId) {
            if (options.requireDownload) {
                await this.assertDownloadLimitAvailable(link);
            }
            return;
        }

        let policy;

        try {
            policy = await OrganizationPolicyService.getEffectiveSharingPolicy(link.ownerId, link.organizationId);
        } catch (error) {
            throw new PublicShareError('This organization link is not currently available.', 403, 'ORG_LINK_BLOCKED');
        }

        if (policy.publicLinkSharingAllowed === false || policy.externalSharingAllowed === false) {
            throw new PublicShareError('Public link sharing is blocked by organization policy.', 403, 'PUBLIC_LINK_BLOCKED');
        }

        if (policy.requireExternalApproval) {
            throw new PublicShareError('Public links are blocked while external sharing approval is required by organization policy.', 403, 'PUBLIC_LINK_APPROVAL_REQUIRED');
        }

        if (policy.requireExternalExpiration && !link.expiresAt) {
            throw new PublicShareError('This public link no longer satisfies the organization expiration policy.', 403, 'PUBLIC_LINK_EXPIRY_REQUIRED');
        }

        if (!policy.allowedPermissions.includes(link.permission)) {
            throw new PublicShareError(`The "${link.permission}" permission is blocked by organization policy.`, 403, 'PERMISSION_BLOCKED');
        }

        if (options.requireDownload) {
            const maxDownloads = OrganizationPolicyService.getPolicyMaxDownloads(policy);
            if (maxDownloads !== null && this.getDownloadCount(link) >= maxDownloads) {
                throw new PublicShareError('The download limit for this public link has been reached.', 403, 'DOWNLOAD_LIMIT_REACHED');
            }
        }
    }

    static async getMetadata(token) {
        const { link, item } = await this.resolvePublicShare(token);
        const mimetype = link.itemType === 'file' ? item.mimetype || mime.getType(item.name) : null;

        return {
            success: true,
            item: {
                name: item.name,
                isFolder: link.itemType === 'folder',
                mimetype,
                type: link.itemType === 'folder' ? 'Folder' : (mimetype || 'File'),
                size: item.size || 0,
                isPasswordProtected: !!item.isPasswordProtected
            },
            link: {
                permission: link.permission,
                canDownload: link.permission === 'download',
                expiresAt: link.expiresAt,
                requiresPassword: !!item.isPasswordProtected,
                maxDownloads: await this.getEffectiveLinkMaxDownloads(link),
                downloadCount: link.downloadCount || 0
            }
        };
    }

    static async verifyPassword(token, password) {
        if (!password) {
            throw new PublicShareError('Password is required.', 400, 'PASSWORD_MISSING');
        }

        const { link, item } = await this.resolvePublicShare(token, { includePassword: true });

        if (!item.isPasswordProtected) {
            return {
                success: true,
                accessToken: null
            };
        }

        const isValid = await bcrypt.compare(password, item.password || '');
        if (!isValid) {
            throw new PublicShareError('Invalid password.', 401, 'INVALID_PASSWORD');
        }

        return {
            success: true,
            accessToken: this.createPasswordAccessToken(link, item)
        };
    }

    static async getFileContent(token, accessToken) {
        const { link, item } = await this.resolvePublicShare(token, {
            requirePassword: true,
            accessToken,
            markAccessed: true
        });

        if (link.itemType === 'folder') {
            throw new PublicShareError('Folder preview is not available from direct links.', 400, 'FOLDER_PREVIEW_UNAVAILABLE');
        }

        if (!await StorageService.fileExists(item)) {
            throw new PublicShareError('The shared file is missing from storage.', 404, 'ITEM_UNAVAILABLE');
        }

        const mimeType = item.mimetype || mime.getType(item.name) || 'application/octet-stream';
        if (!this.isPreviewableMimeType(mimeType)) {
            throw new PublicShareError('Preview is not available for this file type.', 415, 'PREVIEW_UNAVAILABLE');
        }

        return {
            item,
            mimeType,
            stream: await StorageService.createReadStream(item)
        };
    }

    static async getDownload(token, accessToken) {
        const { link, item } = await this.resolvePublicShare(token, {
            requireDownload: true,
            requirePassword: true,
            accessToken,
            markAccessed: true
        });

        if (link.itemType === 'folder') {
            return {
                item,
                fileName: `${item.name}.zip`,
                mimeType: 'application/zip',
                stream: await this.createFolderArchive(item)
            };
        }

        if (!await StorageService.fileExists(item)) {
            throw new PublicShareError('The shared file is missing from storage.', 404, 'ITEM_UNAVAILABLE');
        }

        return {
            item,
            fileName: item.name,
            mimeType: item.mimetype || mime.getType(item.name) || 'application/octet-stream',
            stream: await StorageService.createReadStream(item)
        };
    }

    static async getFolderChildren(token, accessToken) {
        const { link, item } = await this.resolvePublicShare(token, {
            requirePassword: true,
            accessToken,
            markAccessed: true
        });

        if (link.itemType !== 'folder') {
            throw new PublicShareError('This shared item is not a folder.', 400, 'NOT_A_FOLDER');
        }

        const baseQuery = {
            userId: item.userId.toString(),
            parent_id: item._id.toString(),
            deleted: false
        };
        const visibleFileQuery = {
            ...baseQuery,
            isPasswordProtected: { $ne: true }
        };
        const visibleFolderQuery = {
            ...baseQuery,
            isPasswordProtected: { $ne: true }
        };

        const [files, folders, totalFiles, totalFolders] = await Promise.all([
            File.find(visibleFileQuery).sort({ name: 1 }),
            Folder.find(visibleFolderQuery).sort({ name: 1 }).lean(),
            File.countDocuments(baseQuery),
            Folder.countDocuments(baseQuery)
        ]);

        const folderItems = folders.map(folder => ({
            id: folder._id.toString(),
            name: folder.name,
            isFolder: true,
            type: 'Folder',
            mimetype: null,
            size: folder.size || 0,
            createdAt: folder.createdAt,
            hasChildren: (folder.fileCount || 0) + (folder.folderCount || 0) > 0
        }));

        const fileItems = [];
        for (const file of files) {
            const availability = await this.prepareFileForPublicAccess(file);
            if (!availability.available) {
                continue;
            }

            fileItems.push({
                id: file._id.toString(),
                name: file.name,
                isFolder: false,
                type: file.mimetype || mime.getType(file.name) || 'File',
                mimetype: file.mimetype || mime.getType(file.name),
                size: file.size || 0,
                createdAt: file.createdAt
            });
        }

        return {
            success: true,
            folder: {
                id: item._id.toString(),
                name: item.name,
                size: item.size || 0
            },
            children: [...folderItems, ...fileItems],
            hiddenCount: Math.max(0, (totalFiles + totalFolders) - (files.length + folders.length))
        };
    }

    static async createFolderArchive(folder) {
        const archive = archiver('zip', { zlib: { level: 6 } });

        process.nextTick(async () => {
            try {
                await this.appendFolderToArchive(archive, folder, folder.name);
                await archive.finalize();
            } catch (error) {
                archive.emit('error', error);
            }
        });

        return archive;
    }

    static async appendFolderToArchive(archive, folder, prefix) {
        const [files, subfolders] = await Promise.all([
            File.find({
                userId: folder.userId.toString(),
                parent_id: folder._id.toString(),
                deleted: false,
                isPasswordProtected: { $ne: true }
            }),
            Folder.find({
                userId: folder.userId.toString(),
                parent_id: folder._id.toString(),
                deleted: false,
                isPasswordProtected: { $ne: true }
            })
        ]);

        if (!files.length && !subfolders.length) {
            archive.append('', { name: `${prefix}/` });
            return;
        }

        for (const file of files) {
            const availability = await this.prepareFileForPublicAccess(file);
            if (!availability.available) {
                continue;
            }

            if (!await StorageService.fileExists(file)) {
                continue;
            }

            const stream = await StorageService.createReadStream(file);
            archive.append(stream, { name: path.posix.join(prefix, file.name) });
        }

        for (const subfolder of subfolders) {
            await this.appendFolderToArchive(archive, subfolder, path.posix.join(prefix, subfolder.name));
        }
    }

    static getAccessTokenFromRequest(req) {
        const header = req.headers.authorization || '';
        if (header.startsWith('Bearer ')) {
            return header.slice(7);
        }

        return req.query.accessToken || req.body.accessToken || null;
    }
}

ShareLinkService.PublicShareError = PublicShareError;

module.exports = ShareLinkService;
