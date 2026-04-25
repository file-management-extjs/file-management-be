const path = require('path');
const File = require('../models/fileModel');
const Folder = require('../models/folderModel');
const UploadProgress = require('../models/uplodPrgress');
const User = require('../models/userModel');
const config = require('../config');
const { fileEvents, EVENT_TYPES } = require('./eventService');
const WorkspaceService = require('./workspaceService');

const MB = 1024 * 1024;
const GB = 1024 * MB;
const CATEGORY_ORDER = ['Images', 'Videos', 'Audio', 'PDFs', 'Documents', 'Archives', 'Other'];
const CATEGORY_ICONS = {
    Images: 'fa fa-image green-icon',
    Videos: 'fa fa-film blue-icon',
    Audio: 'fa fa-music blue-icon',
    PDFs: 'fa fa-file-pdf red-icon',
    Documents: 'fa fa-file-lines blue-icon',
    Archives: 'fa fa-file-archive yellow-icon',
    Other: 'fa fa-file'
};

class StorageInsightsService {
    static async getWorkspaceContext(userId, options = {}) {
        return WorkspaceService.assertWorkspaceAccess(userId, options.workspaceId || null);
    }

    static getBaseFilesQuery(userId, extra = {}, workspaceContext = null) {
        return {
            ...(workspaceContext && workspaceContext.workspace
                ? { workspaceId: workspaceContext.workspace._id.toString() }
                : { userId: userId.toString() }),
            deleted: false,
            ...extra
        };
    }

    static getFoldersQuery(userId, extra = {}, workspaceContext = null) {
        return {
            ...(workspaceContext && workspaceContext.workspace
                ? { workspaceId: workspaceContext.workspace._id.toString() }
                : { userId: userId.toString() }),
            deleted: false,
            ...extra
        };
    }

    static normalizeLimit(value, fallback, max) {
        const parsed = parseInt(value, 10);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            return fallback;
        }

        return Math.min(parsed, max);
    }

    static getCacheKey(userId, options = {}) {
        return options.workspaceId ? `${userId}:workspace:${options.workspaceId}` : userId.toString();
    }

    static invalidateUser(userId) {
        if (!userId) {
            StorageInsightsService.cache.clear();
            return;
        }

        const prefix = `${userId}:workspace:`;
        StorageInsightsService.cache.delete(StorageInsightsService.getCacheKey(userId));
        Array.from(StorageInsightsService.cache.keys()).forEach(key => {
            if (String(key).startsWith(prefix) || String(key).includes(`workspace:${userId}`)) {
                StorageInsightsService.cache.delete(key);
            }
        });
    }

    static async getStorageInsights(userId, options = {}) {
        const cacheKey = this.getCacheKey(userId, options);
        const now = Date.now();
        const cached = StorageInsightsService.cache.get(cacheKey);
        const ttlMs = StorageInsightsService.cacheTtlMs;

        if (!options.refresh && cached && now - cached.createdAt < ttlMs) {
            return cached.payload;
        }

        const payload = await this.computeStorageInsights(userId, options);
        StorageInsightsService.cache.set(cacheKey, {
            createdAt: now,
            payload
        });

        return payload;
    }

    static async computeStorageInsights(userId, options = {}) {
        const workspaceContext = await this.getWorkspaceContext(userId, options);
        const filesQuery = this.getBaseFilesQuery(userId, {}, workspaceContext);
        const largestFilesLimit = this.normalizeLimit(options.largestFilesLimit, 12, 50);
        const largestFoldersLimit = this.normalizeLimit(options.largestFoldersLimit, 12, 50);
        const folderVisualizationLimit = this.normalizeLimit(options.folderVisualizationLimit, 500, 1500);
        const extensionBreakdownLimit = this.normalizeLimit(options.extensionBreakdownLimit, 12, 50);

        const [
            quotaBytes,
            storageResult,
            fileCount,
            folderCount,
            typeBreakdown,
            extensionBreakdown,
            largestFiles,
            largestFolders,
            folderVisualization,
            growthTrend,
            cleanupSignals
        ] = await Promise.all([
            this.getQuotaBytes(userId),
            File.aggregate([
                { $match: filesQuery },
                {
                    $group: {
                        _id: null,
                        usedBytes: { $sum: { $ifNull: ['$size', 0] } }
                    }
                }
            ]),
            File.countDocuments(filesQuery),
            Folder.countDocuments(this.getFoldersQuery(userId, {}, workspaceContext)),
            this.getUsageByFileType(userId, filesQuery),
            this.getExtensionBreakdown(filesQuery, extensionBreakdownLimit),
            this.getLargestFiles(userId, filesQuery, largestFilesLimit, workspaceContext),
            this.getLargestFolders(userId, largestFoldersLimit, workspaceContext),
            this.getFolderVisualization(userId, filesQuery, folderVisualizationLimit, workspaceContext),
            this.getGrowthTrend(userId, filesQuery),
            this.getCleanupSignals(userId, filesQuery, workspaceContext)
        ]);

        const usedBytes = storageResult[0]?.usedBytes || 0;
        const remainingBytes = Math.max(quotaBytes - usedBytes, 0);
        const usagePercent = quotaBytes > 0 ? Math.min(100, (usedBytes / quotaBytes) * 100) : 0;

        return {
            summary: {
                quotaBytes,
                usedBytes,
                remainingBytes,
                usagePercent: Math.round(usagePercent * 10) / 10,
                fileCount,
                folderCount
            },
            usageByFileType: this.addPercentages(typeBreakdown, usedBytes),
            extensionBreakdown: this.addExtensionPercentages(extensionBreakdown, usedBytes),
            largestFiles,
            largestFolders,
            folderVisualization,
            growthTrend,
            cleanupSignals,
            generatedAt: new Date(),
            cacheTtlMs: StorageInsightsService.cacheTtlMs
        };
    }

    static async getQuotaBytes(userId) {
        const user = await User.findById(userId).select('settings storageQuotaBytes').lean();
        const configuredQuota = Number(
            user?.storageQuotaBytes ||
            user?.settings?.storage?.quotaBytes ||
            config.storage.defaultQuotaBytes
        );

        if (Number.isFinite(configuredQuota) && configuredQuota > 0) {
            return configuredQuota;
        }

        return 15 * GB;
    }

    static classifyFile(file = {}) {
        const mimetype = String(file.mimetype || '').toLowerCase();
        const extension = path.extname(file.name || '').toLowerCase();

        if (mimetype.startsWith('image/')) return 'Images';
        if (mimetype.startsWith('video/')) return 'Videos';
        if (mimetype.startsWith('audio/')) return 'Audio';
        if (mimetype === 'application/pdf' || extension === '.pdf') return 'PDFs';

        if (
            mimetype.includes('zip') ||
            mimetype.includes('rar') ||
            mimetype.includes('7z') ||
            mimetype.includes('tar') ||
            mimetype.includes('gzip') ||
            ['.zip', '.rar', '.7z', '.tar', '.gz', '.tgz'].includes(extension)
        ) {
            return 'Archives';
        }

        if (
            mimetype.startsWith('text/') ||
            mimetype.includes('word') ||
            mimetype.includes('excel') ||
            mimetype.includes('powerpoint') ||
            mimetype.includes('spreadsheet') ||
            mimetype.includes('presentation') ||
            mimetype.includes('opendocument') ||
            ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.rtf', '.csv', '.md', '.odt', '.ods', '.odp'].includes(extension)
        ) {
            return 'Documents';
        }

        return 'Other';
    }

    static getCategoryLabel(mimetype, name = '') {
        return this.classifyFile({ mimetype, name });
    }

    static addPercentages(entries, totalBytes) {
        return CATEGORY_ORDER.map((category) => {
            const entry = entries.find(item => item.category === category) || {
                category,
                count: 0,
                bytes: 0
            };

            return {
                category,
                count: entry.count || 0,
                bytes: entry.bytes || 0,
                percent: totalBytes > 0 ? Math.round(((entry.bytes || 0) / totalBytes) * 1000) / 10 : 0,
                iconCls: CATEGORY_ICONS[category] || CATEGORY_ICONS.Other
            };
        });
    }

    static async getUsageByFileType(userId, filesQuery) {
        const usageByMimeType = await File.aggregate([
            { $match: filesQuery },
            {
                $group: {
                    _id: '$mimetype',
                    count: { $sum: 1 },
                    bytes: { $sum: { $ifNull: ['$size', 0] } }
                }
            }
        ]);

        const categories = new Map();
        CATEGORY_ORDER.forEach(category => categories.set(category, {
            category,
            count: 0,
            bytes: 0
        }));

        usageByMimeType.forEach((entry) => {
            const category = this.getCategoryLabel(entry._id);
            const current = categories.get(category) || categories.get('Other');
            current.count += entry.count || 0;
            current.bytes += entry.bytes || 0;
        });

        return Array.from(categories.values())
            .sort((first, second) => second.bytes - first.bytes || second.count - first.count);
    }

    static addExtensionPercentages(entries, totalBytes) {
        return (entries || []).map((entry, index) => ({
            ...entry,
            percent: totalBytes > 0 ? Math.round(((entry.bytes || 0) / totalBytes) * 1000) / 10 : 0,
            colorIndex: index
        }));
    }

    static async getExtensionBreakdown(filesQuery, limit) {
        const files = await File.find(filesQuery)
            .select('name mimetype size')
            .lean();
        const groups = new Map();

        files.forEach((file) => {
            const extension = this.getDisplayExtension(file.name);
            const fileType = this.getCategoryLabel(file.mimetype, file.name);
            const key = `${extension}|${fileType}`;
            const current = groups.get(key) || {
                extension,
                fileType,
                count: 0,
                bytes: 0
            };

            current.count += 1;
            current.bytes += file.size || 0;
            groups.set(key, current);
        });

        return Array.from(groups.values())
            .sort((first, second) => second.bytes - first.bytes || second.count - first.count)
            .slice(0, limit);
    }

    static getDisplayExtension(name) {
        const extension = path.extname(name || '').toLowerCase();
        return extension || '[none]';
    }

    static async getLargestFiles(userId, filesQuery, limit, workspaceContext = null) {
        const files = await File.find(filesQuery)
            .select('_id name path parent_id mimetype size createdAt updatedAt scanStatus')
            .sort({ size: -1, updatedAt: -1 })
            .limit(limit)
            .lean();

        return Promise.all(files.map(async (file) => ({
            id: file._id.toString(),
            name: file.name,
            path: file.path,
            folderPath: this.getDisplayPath(file.path, userId, true, workspaceContext),
            parent_id: file.parent_id || null,
            mimetype: file.mimetype || '',
            type: this.getCategoryLabel(file.mimetype, file.name),
            size: file.size || 0,
            createdAt: file.createdAt,
            updatedAt: file.updatedAt || file.createdAt,
            scanStatus: file.scanStatus || 'unscanned',
            ancestors: await this.buildFolderAncestors(userId, file.parent_id, workspaceContext)
        })));
    }

    static async getLargestFolders(userId, limit, workspaceContext = null) {
        const folders = await Folder.find(this.getFoldersQuery(userId, { size: { $gt: 0 } }, workspaceContext))
            .select('_id name path parent_id size fileCount folderCount createdAt')
            .sort({ size: -1, createdAt: -1 })
            .limit(limit)
            .lean();

        return Promise.all(folders.map(async (folder) => ({
            id: folder._id.toString(),
            name: folder.name,
            path: folder.path,
            displayPath: this.getDisplayPath(folder.path, userId, false, workspaceContext),
            parent_id: folder.parent_id || null,
            size: folder.size || 0,
            fileCount: folder.fileCount || 0,
            folderCount: folder.folderCount || 0,
            createdAt: folder.createdAt,
            ancestors: await this.buildFolderAncestors(userId, folder._id, workspaceContext)
        })));
    }

    static async getFolderVisualization(userId, filesQuery, limit, workspaceContext = null) {
        const foldersQuery = this.getFoldersQuery(userId, {}, workspaceContext);
        const [totalFolders, folders, directFileGroups] = await Promise.all([
            Folder.countDocuments(foldersQuery),
            Folder.find(foldersQuery)
                .select('_id name path parent_id size fileCount folderCount createdAt')
                .sort({ size: -1, path: 1 })
                .limit(limit)
                .lean(),
            File.aggregate([
                { $match: filesQuery },
                {
                    $group: {
                        _id: { $ifNull: ['$parent_id', 'root'] },
                        bytes: { $sum: { $ifNull: ['$size', 0] } },
                        count: { $sum: 1 }
                    }
                }
            ])
        ]);

        const root = {
            id: 'root',
            name: 'Workspace',
            path: '/',
            type: 'root',
            size: 0,
            children: []
        };
        const nodesById = new Map();
        const directFilesByParent = new Map();

        directFileGroups.forEach((entry) => {
            const key = entry._id ? entry._id.toString() : 'root';
            root.size += entry.bytes || 0;
            directFilesByParent.set(key, {
                bytes: entry.bytes || 0,
                count: entry.count || 0
            });
        });

        folders.forEach((folder) => {
            nodesById.set(folder._id.toString(), {
                id: folder._id.toString(),
                name: folder.name,
                path: this.getDisplayPath(folder.path, userId, false, workspaceContext),
                parent_id: folder.parent_id || null,
                type: 'folder',
                size: folder.size || 0,
                fileCount: folder.fileCount || 0,
                folderCount: folder.folderCount || 0,
                createdAt: folder.createdAt,
                children: []
            });
        });

        nodesById.forEach((node) => {
            const parent = node.parent_id ? nodesById.get(node.parent_id.toString()) : root;
            (parent || root).children.push(node);
        });

        nodesById.forEach((node, id) => {
            const directFiles = directFilesByParent.get(id);
            if (directFiles && directFiles.bytes > 0) {
                node.children.push({
                    id: `${id}:files`,
                    name: 'Files in this folder',
                    path: node.path,
                    type: 'files',
                    size: directFiles.bytes,
                    fileCount: directFiles.count,
                    leaf: true
                });
            }
        });

        const rootFiles = directFilesByParent.get('root');
        if (rootFiles && rootFiles.bytes > 0) {
            root.children.push({
                id: 'root:files',
                name: 'Files at root',
                path: '/',
                type: 'files',
                size: rootFiles.bytes,
                fileCount: rootFiles.count,
                leaf: true
            });
        }

        this.balanceFolderTree(root);
        this.sortFolderTree(root);

        return {
            root,
            totalFolders,
            returnedFolders: folders.length,
            truncated: totalFolders > folders.length
        };
    }

    static balanceFolderTree(node) {
        if (!node.children || node.children.length === 0) {
            return node.size || 0;
        }

        let childSize = 0;
        node.children.forEach((child) => {
            childSize += this.balanceFolderTree(child);
        });

        const remainder = Math.max((node.size || 0) - childSize, 0);
        if (remainder > 0) {
            node.children.push({
                id: `${node.id}:other`,
                name: node.type === 'root' ? 'Other workspace storage' : 'Other nested storage',
                path: node.path,
                type: 'other',
                size: remainder,
                leaf: true
            });
        }

        return Math.max(node.size || 0, childSize + remainder);
    }

    static sortFolderTree(node) {
        if (!node.children || node.children.length === 0) {
            return;
        }

        node.children.sort((first, second) => (second.size || 0) - (first.size || 0));
        node.children.forEach(child => this.sortFolderTree(child));
    }

    static async getGrowthTrend(userId, filesQuery) {
        const ranges = [7, 30, 90];
        const entries = await Promise.all(
            ranges.map(days => this.getGrowthTrendForRange(filesQuery, days))
        );

        return {
            defaultRange: 30,
            source: 'createdAt',
            ranges: entries.reduce((result, entry) => {
                result[entry.days] = entry.points;
                return result;
            }, {})
        };
    }

    static async getGrowthTrendForRange(filesQuery, days) {
        const now = new Date();
        const start = new Date(now);
        start.setDate(start.getDate() - (days - 1));
        start.setHours(0, 0, 0, 0);

        const [baselineResult, dailyResult] = await Promise.all([
            File.aggregate([
                { $match: { ...filesQuery, createdAt: { $lt: start } } },
                {
                    $group: {
                        _id: null,
                        bytes: { $sum: { $ifNull: ['$size', 0] } }
                    }
                }
            ]),
            File.aggregate([
                { $match: { ...filesQuery, createdAt: { $gte: start, $lte: now } } },
                {
                    $group: {
                        _id: {
                            $dateToString: {
                                format: '%Y-%m-%d',
                                date: '$createdAt'
                            }
                        },
                        bytes: { $sum: { $ifNull: ['$size', 0] } },
                        count: { $sum: 1 }
                    }
                },
                { $sort: { _id: 1 } }
            ])
        ]);

        const dailyByDate = dailyResult.reduce((result, entry) => {
            result[entry._id] = {
                bytes: entry.bytes || 0,
                count: entry.count || 0
            };
            return result;
        }, {});
        const points = [];
        let cumulativeBytes = baselineResult[0]?.bytes || 0;

        for (let offset = 0; offset < days; offset += 1) {
            const current = new Date(start);
            current.setDate(start.getDate() + offset);
            const dateKey = current.toISOString().slice(0, 10);
            const daily = dailyByDate[dateKey] || { bytes: 0, count: 0 };
            cumulativeBytes += daily.bytes;
            points.push({
                date: dateKey,
                addedBytes: daily.bytes,
                addedFiles: daily.count,
                usedBytes: cumulativeBytes
            });
        }

        return {
            days,
            points
        };
    }

    static async getCleanupSignals(userId, filesQuery, workspaceContext = null) {
        const now = Date.now();
        const largeFileThreshold = Math.max(100 * MB, 0);
        const oldLargeThreshold = 50 * MB;
        const oldCutoff = new Date(now - 180 * 24 * 60 * 60 * 1000);

        const [
            veryLargeFiles,
            oldLargeFiles,
            interruptedUploads,
            scanIssueResult,
            scanIssueFiles
        ] = await Promise.all([
            File.find({ ...filesQuery, size: { $gte: largeFileThreshold } })
                .select('_id name path parent_id mimetype size updatedAt createdAt')
                .sort({ size: -1 })
                .limit(8)
                .lean(),
            File.find({
                ...filesQuery,
                size: { $gte: oldLargeThreshold },
                updatedAt: { $lt: oldCutoff }
            })
                .select('_id name path parent_id mimetype size updatedAt createdAt')
                .sort({ size: -1 })
                .limit(8)
                .lean(),
            UploadProgress.find({
                userId,
                ...(workspaceContext && workspaceContext.workspace ? { workspaceId: workspaceContext.workspace._id.toString() } : {})
            })
                .select('_id filename folderId fileSize totalChunks uploadedChunks createdAt')
                .sort({ createdAt: -1 })
                .limit(20)
                .lean(),
            File.aggregate([
                {
                    $match: {
                        ...filesQuery,
                        scanStatus: { $in: ['pending', 'scanning', 'infected'] }
                    }
                },
                {
                    $group: {
                        _id: '$scanStatus',
                        count: { $sum: 1 },
                        bytes: { $sum: { $ifNull: ['$size', 0] } }
                    }
                }
            ]),
            File.find({
                ...filesQuery,
                scanStatus: { $in: ['pending', 'scanning', 'infected'] }
            })
                .select('_id name path parent_id mimetype size updatedAt createdAt scanStatus scanProgress scanResult')
                .sort({ updatedAt: -1 })
                .limit(8)
                .lean()
        ]);

        const serializeCleanupFile = async (file) => ({
            id: file._id.toString(),
            name: file.name,
            path: file.path,
            folderPath: this.getDisplayPath(file.path, userId, true, workspaceContext),
            parent_id: file.parent_id || null,
            mimetype: file.mimetype || '',
            type: this.getCategoryLabel(file.mimetype, file.name),
            size: file.size || 0,
            createdAt: file.createdAt,
            updatedAt: file.updatedAt || file.createdAt,
            scanStatus: file.scanStatus || null,
            scanProgress: file.scanProgress || 0,
            scanResult: file.scanResult || null,
            ancestors: await this.buildFolderAncestors(userId, file.parent_id, workspaceContext)
        });

        const unfinishedUploads = interruptedUploads
            .filter(upload => !upload.totalChunks || (upload.uploadedChunks || []).length < upload.totalChunks)
            .map(upload => {
                const uploadedChunkCount = (upload.uploadedChunks || []).length;
                const estimatedBytes = upload.fileSize && upload.totalChunks
                    ? Math.round((upload.fileSize / upload.totalChunks) * uploadedChunkCount)
                    : 0;

                return {
                    id: upload._id.toString(),
                    filename: upload.filename,
                    folderId: upload.folderId || null,
                    fileSize: upload.fileSize || 0,
                    totalChunks: upload.totalChunks || 0,
                    uploadedChunks: uploadedChunkCount,
                    estimatedBytes,
                    createdAt: upload.createdAt
                };
            });

        const scanIssues = scanIssueResult.reduce((result, entry) => {
            result[entry._id] = {
                count: entry.count || 0,
                bytes: entry.bytes || 0
            };
            return result;
        }, {
            pending: { count: 0, bytes: 0 },
            scanning: { count: 0, bytes: 0 },
            infected: { count: 0, bytes: 0 }
        });

        return {
            thresholds: {
                veryLargeBytes: largeFileThreshold,
                oldLargeBytes: oldLargeThreshold,
                oldLargeOlderThanDays: 180
            },
            veryLargeFiles: await Promise.all(veryLargeFiles.map(serializeCleanupFile)),
            oldLargeFiles: await Promise.all(oldLargeFiles.map(serializeCleanupFile)),
            interruptedUploads: unfinishedUploads.slice(0, 8),
            interruptedUploadCount: unfinishedUploads.length,
            interruptedUploadEstimatedBytes: unfinishedUploads.reduce((sum, upload) => sum + upload.estimatedBytes, 0),
            scanIssues,
            scanIssueFiles: await Promise.all(scanIssueFiles.map(serializeCleanupFile)),
            trash: {
                supported: false,
                bytes: 0,
                count: 0
            },
            duplicates: {
                supported: false
            }
        };
    }

    static async buildFolderAncestors(userId, folderId, workspaceContext = null) {
        const ancestors = [];
        let currentFolderId = folderId;
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
                query.userId = userId.toString();
            }

            const folder = await Folder.findOne(query).select('_id name parent_id').lean();

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

    static getDisplayPath(value, userId, folderOnly = false, workspaceContext = null) {
        const normalized = String(value || '').replace(/\\/g, '/');
        const parts = normalized.split('/').filter(Boolean);

        if (parts[0] === userId.toString()) {
            parts.shift();
        }

        const rootPath = workspaceContext && workspaceContext.workspace
            ? String(workspaceContext.workspace.rootPath || '').replace(/\\/g, '/').split('/').filter(Boolean)
            : [];
        if (rootPath.length && rootPath.every((part, index) => parts[index] === part)) {
            parts.splice(0, rootPath.length);
        }

        if (folderOnly && parts.length > 0) {
            parts.pop();
        }

        return parts.length ? `/${parts.join('/')}` : '/';
    }
}

StorageInsightsService.cache = new Map();
StorageInsightsService.cacheTtlMs = parseInt(process.env.STORAGE_INSIGHTS_CACHE_TTL_MS || '60000', 10);

fileEvents.on(EVENT_TYPES.FILE_UPLOADED, data => StorageInsightsService.invalidateUser(data.userId));
fileEvents.on(EVENT_TYPES.FILE_DELETED, data => StorageInsightsService.invalidateUser(data.userId));
fileEvents.on(EVENT_TYPES.FILE_UPDATED, data => StorageInsightsService.invalidateUser(data.userId));

module.exports = StorageInsightsService;
