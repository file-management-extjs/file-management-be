const File = require('../models/fileModel');
const Folder = require('../models/folderModel');
const { ACCESS_VERIFICATION_WINDOW_MS } = require('../constants/access');
const WorkspaceService = require('./workspaceService');

class SearchService {
    static escapeRegExp(value) {
        return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    static hasValidRecentAccess(item, userId) {
        const userAccess = item.userAccess && item.userAccess.find(
            access => access.userId === userId.toString()
        );
        const lastAccessed = userAccess ? new Date(userAccess.lastAccessed) : null;

        return !!lastAccessed && (Date.now() - lastAccessed.getTime()) <= ACCESS_VERIFICATION_WINDOW_MS;
    }

    static getScopedQuery(workspaceContext, extra = {}) {
        return {
            workspaceId: workspaceContext.workspace._id.toString(),
            ...extra
        };
    }

    static async hasLockedProtectedAncestor(userId, folderId, workspaceContext) {
        let currentFolderId = folderId;
        const scopedQuery = this.getScopedQuery(workspaceContext);

        while (currentFolderId) {
            const folder = await Folder.findOne({
                _id: currentFolderId,
                ...scopedQuery,
                deleted: false
            })
                .select('_id parent_id isPasswordProtected userAccess')
                .lean();

            if (!folder) {
                break;
            }

            if (folder.isPasswordProtected && !this.hasValidRecentAccess(folder, userId)) {
                return true;
            }

            currentFolderId = folder.parent_id;
        }

        return false;
    }

    static async isVisibleInSearch(userId, item, workspaceContext) {
        return !await this.hasLockedProtectedAncestor(userId, item.parent_id, workspaceContext);
    }

    static async buildFolderAncestors(userId, folderId, workspaceContext) {
        const ancestors = [];
        let currentFolderId = folderId;
        const scopedQuery = this.getScopedQuery(workspaceContext);

        while (currentFolderId) {
            const folder = await Folder.findOne({
                _id: currentFolderId,
                ...scopedQuery,
                deleted: false
            })
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

    static buildContentSearchFilter(searchRegex) {
        return {
            $or: [
                { name: searchRegex },
                { path: searchRegex },
                { 'contentIntelligence.searchableText': searchRegex },
                { 'contentIntelligence.tags': searchRegex },
                { 'contentIntelligence.classification': searchRegex },
                { 'contentIntelligence.summary': searchRegex }
            ]
        };
    }

    /**
     * Search for files and folders by name and extracted content
     * @param {string} userId - The ID of the user performing the search
     * @param {string} query - The search query
     * @param {number} limit - Maximum number of results to return
     * @returns {Promise<Array>} - Array of search results
     */
    static async searchItems(userId, query, limit = 10, options = {}) {
        try {
            const workspaceContext = await WorkspaceService.assertWorkspaceAccess(userId, options.workspaceId || null);
            const scopedQuery = this.getScopedQuery(workspaceContext);
            const searchRegex = new RegExp(this.escapeRegExp(query), 'i');
            const [files, folders] = await Promise.all([
                // Search in files
                File.find({
                    ...scopedQuery,
                    deleted: false,
                    ...this.buildContentSearchFilter(searchRegex)
                })
                .select('name path mimetype size createdAt parent_id isPasswordProtected workspaceId workspaceType organizationId createdByUserId userId contentIntelligence.status contentIntelligence.classification contentIntelligence.tags contentIntelligence.textExcerpt')
                .limit(limit)
                .lean(),

                // Search in folders
                Folder.find({
                    ...scopedQuery,
                    deleted: false,
                    name: searchRegex
                })
                .select('name path size createdAt parent_id isPasswordProtected workspaceId workspaceType organizationId createdByUserId userId')
                .limit(limit)
                .lean()
            ]);

            const visibleFolders = [];
            for (const folder of folders) {
                if (!await this.isVisibleInSearch(userId, folder, workspaceContext)) {
                    continue;
                }

                visibleFolders.push(folder);
            }

            const visibleFiles = [];
            for (const file of files) {
                if (!await this.isVisibleInSearch(userId, file, workspaceContext)) {
                    continue;
                }

                visibleFiles.push(file);
            }

            const folderResults = await Promise.all(visibleFolders.map(async (folder) => ({
                id: folder._id,
                name: folder.name,
                path: folder.path,
                type: 'Folder',
                size: folder.size,
                createdAt: folder.createdAt,
                isFolder: true,
                isPasswordProtected: folder.isPasswordProtected,
                parent_id: folder.parent_id,
                ownerId: folder.userId ? folder.userId.toString() : '',
                createdByUserId: folder.createdByUserId || '',
                workspaceId: folder.workspaceId || '',
                workspaceType: folder.workspaceType || '',
                organizationId: folder.organizationId || '',
                ancestors: await this.buildFolderAncestors(userId, folder._id, workspaceContext)
            })));

            const fileResults = await Promise.all(visibleFiles.map(async (file) => ({
                id: file._id,
                name: file.name,
                path: file.path,
                type: file.mimetype,
                size: file.size,
                createdAt: file.createdAt,
                isFolder: false,
                isPasswordProtected: file.isPasswordProtected,
                parent_id: file.parent_id,
                ownerId: file.userId ? file.userId.toString() : '',
                createdByUserId: file.createdByUserId || '',
                workspaceId: file.workspaceId || '',
                workspaceType: file.workspaceType || '',
                organizationId: file.organizationId || '',
                contentIntelligence: file.contentIntelligence || null,
                ancestors: await this.buildFolderAncestors(userId, file.parent_id, workspaceContext)
            })));

            // Format results
            const results = [
                ...folderResults,
                ...fileResults
            ];

            return results;
        } catch (error) {
            console.error('Error in searchItems:', error);
            throw new Error('Failed to search items');
        }
    }
}

module.exports = SearchService;
