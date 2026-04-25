const ActivityEvent = require('../models/activityEventModel');
const User = require('../models/userModel');
const socket = require('../socket');

function safeId(value) {
    return value && value.toString ? value.toString() : String(value || '');
}

function normalizeUserIds(userIds = []) {
    return [...new Set(
        (Array.isArray(userIds) ? userIds : [userIds])
            .filter(Boolean)
            .map(userId => userId.toString())
    )];
}

function getItemTypeLabel(itemType, item = {}) {
    if (itemType === 'folder') {
        return 'Folder';
    }

    const mimetype = String(item.mimetype || '').trim();
    if (mimetype) {
        return mimetype;
    }

    return 'File';
}

class ActivityEventService {
    static serialize(event) {
        const row = event && event.toObject ? event.toObject() : event;

        return {
            id: `event-${safeId(row._id || row.id)}`,
            source: row.source || 'event',
            activityType: row.activityType || 'Activity',
            iconCls: row.iconCls || 'fa fa-circle-info blue-icon',
            title: row.title || 'Activity',
            detail: row.detail || '',
            affectedFiles: Array.isArray(row.affectedFiles) ? row.affectedFiles : [],
            affectedFileCount: Number(row.affectedFileCount || (row.affectedFiles || []).length || 0),
            status: row.status || 'completed',
            statusText: row.statusText || 'Completed',
            statusGroup: row.statusGroup || 'completed',
            progress: Number.isFinite(Number(row.progress)) ? Number(row.progress) : 100,
            updatedAt: row.updatedAt || row.createdAt || new Date(),
            createdAt: row.createdAt || row.updatedAt || new Date(),
            canCancel: false,
            canOpenPanel: false,
            relatedEntityType: row.relatedEntityType || null,
            relatedEntityId: row.relatedEntityId || null,
            metadata: row.metadata || {},
            history: true
        };
    }

    static emit(userId, event) {
        try {
            socket.getIO().to(userId.toString()).emit('activityEvent', event);
        } catch (error) {
            // Socket.IO is not available during some service tests and startup paths.
        }
    }

    static async record(userId, payload = {}) {
        if (!userId) {
            return null;
        }

        const affectedFiles = Array.isArray(payload.affectedFiles) ? payload.affectedFiles : [];
        const event = await ActivityEvent.create({
            userId: userId.toString(),
            source: payload.source || 'event',
            activityType: payload.activityType || 'Activity',
            iconCls: payload.iconCls || 'fa fa-circle-info blue-icon',
            title: payload.title || 'Activity',
            detail: payload.detail || '',
            status: payload.status || 'completed',
            statusText: payload.statusText || 'Completed',
            statusGroup: payload.statusGroup || 'completed',
            progress: payload.progress === undefined ? 100 : payload.progress,
            affectedFiles,
            affectedFileCount: payload.affectedFileCount === undefined ? affectedFiles.length : payload.affectedFileCount,
            relatedEntityType: payload.relatedEntityType || null,
            relatedEntityId: payload.relatedEntityId || null,
            metadata: payload.metadata || {}
        });
        const serialized = this.serialize(event);

        this.emit(userId, serialized);
        return serialized;
    }

    static async list(userId, options = {}) {
        if (!userId) {
            return [];
        }

        const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 250);
        const events = await ActivityEvent.find({ userId: userId.toString() })
            .sort({ updatedAt: -1 })
            .limit(limit)
            .lean();

        return events.map(event => this.serialize(event));
    }

    static async getUserLabel(userId) {
        if (!userId) {
            return 'Unknown user';
        }

        const user = await User.findById(userId).select('username email').lean();
        if (!user) {
            return 'Unknown user';
        }

        return user.username || user.email || 'Unknown user';
    }

    static getAffectedItem(item, itemType, statusLabel) {
        return {
            name: item.name || 'Shared item',
            fileName: item.name || 'Shared item',
            path: item.path || '',
            size: item.size || null,
            type: getItemTypeLabel(itemType, item),
            status: String(statusLabel || 'shared').toLowerCase(),
            statusLabel
        };
    }

    static async recordShareCreated(options = {}) {
        const item = options.item || {};
        const itemType = options.itemType || 'file';
        const itemName = item.name || 'item';
        const ownerId = safeId(options.ownerId || options.actorUserId);
        const recipientId = safeId(options.recipientId);
        const actorId = safeId(options.actorUserId || ownerId);
        const targetType = options.targetType || 'member';
        const targetLabel = options.targetLabel || (targetType === 'external' ? 'Anyone with link' : 'shared target');
        const permission = options.permission || (Array.isArray(options.permissions) ? options.permissions[0] : 'download');
        const affectedFiles = [this.getAffectedItem(item, itemType, 'Shared')];
        const shareEntityId = safeId(options.shareId || options.relatedEntityId);

        await this.record(ownerId, {
            activityType: 'Share',
            iconCls: targetType === 'external' ? 'fa fa-link blue-icon' : 'fa fa-share-nodes blue-icon',
            title: `Shared ${itemName}`,
            detail: `Shared with ${targetLabel} (${permission}).`,
            status: 'shared',
            statusText: 'Shared',
            statusGroup: 'completed',
            affectedFiles,
            relatedEntityType: targetType === 'external' ? 'shareLink' : 'share',
            relatedEntityId: shareEntityId,
            metadata: {
                direction: 'outgoing',
                actorUserId: actorId,
                targetType,
                targetLabel,
                permission,
                expiresAt: options.expiresAt || null
            }
        });

        if (targetType === 'member' && recipientId && recipientId !== ownerId) {
            const ownerLabel = await this.getUserLabel(ownerId);
            await this.record(recipientId, {
                activityType: 'Share',
                iconCls: 'fa fa-share-nodes blue-icon',
                title: `${itemName} shared with you`,
                detail: `${ownerLabel} shared this ${itemType} with you (${permission}).`,
                status: 'shared',
                statusText: 'Shared',
                statusGroup: 'completed',
                affectedFiles,
                relatedEntityType: 'share',
                relatedEntityId: shareEntityId,
                metadata: {
                    direction: 'incoming',
                    actorUserId: actorId,
                    ownerId,
                    targetType,
                    permission,
                    expiresAt: options.expiresAt || null
                }
            });
        }
    }

    static async recordShareRevoked(options = {}) {
        const item = options.item || {};
        const itemType = options.itemType || 'file';
        const itemName = item.name || 'item';
        const ownerId = safeId(options.ownerId || options.actorUserId);
        const recipientId = safeId(options.recipientId);
        const actorId = safeId(options.actorUserId || ownerId);
        const targetType = options.targetType || 'member';
        const targetLabel = options.targetLabel || (targetType === 'external' ? 'Anyone with link' : 'shared target');
        const affectedFiles = [this.getAffectedItem(item, itemType, 'Revoked')];
        const shareEntityId = safeId(options.shareId || options.relatedEntityId);
        const ownerLabel = await this.getUserLabel(ownerId);

        await this.record(ownerId, {
            activityType: 'Share',
            iconCls: targetType === 'external' ? 'fa fa-link-slash orange-icon' : 'fa fa-share-nodes orange-icon',
            title: `Revoked share for ${itemName}`,
            detail: `Access for ${targetLabel} was revoked.`,
            status: 'revoked',
            statusText: 'Revoked',
            statusGroup: 'completed',
            affectedFiles,
            relatedEntityType: targetType === 'external' ? 'shareLink' : 'share',
            relatedEntityId: shareEntityId,
            metadata: {
                direction: 'outgoing',
                actorUserId: actorId,
                targetType,
                targetLabel
            }
        });

        if (targetType === 'member' && recipientId && recipientId !== ownerId) {
            await this.record(recipientId, {
                activityType: 'Share',
                iconCls: 'fa fa-share-nodes orange-icon',
                title: `Access revoked for ${itemName}`,
                detail: `${ownerLabel} revoked your access to this ${itemType}.`,
                status: 'revoked',
                statusText: 'Revoked',
                statusGroup: 'completed',
                affectedFiles,
                relatedEntityType: 'share',
                relatedEntityId: shareEntityId,
                metadata: {
                    direction: 'incoming',
                    actorUserId: actorId,
                    ownerId,
                    targetType
                }
            });
        }
    }
}

module.exports = ActivityEventService;
