const mongoose = require('mongoose');

const shareSchema = new mongoose.Schema({
    ownerId: { type: String, required: true, index: true },
    workspaceId: { type: String, default: null, index: true },
    workspaceType: { type: String, enum: ['personal', 'organization', null], default: null },
    recipientId: { type: String, required: true, index: true },
    targetType: {
        type: String,
        enum: ['member', 'team', 'organization', 'external'],
        default: 'member',
        index: true
    },
    targetId: { type: String, default: null, index: true },
    targetLabel: { type: String, default: '' },
    organizationId: { type: String, default: null, index: true },
    createdBy: { type: String, default: null, index: true },
    isExternalTarget: { type: Boolean, default: false, index: true },
    itemId: { type: String, required: true, index: true },
    itemType: {
        type: String,
        enum: ['file', 'folder'],
        required: true
    },
    permission: {
        type: String,
        enum: ['view', 'download', 'upload', 'edit', 'reshare', 'manage'],
        default: 'download'
    },
    permissions: {
        type: [String],
        enum: ['view', 'download', 'upload', 'edit', 'reshare', 'manage'],
        default: undefined
    },
    approvalStatus: {
        type: String,
        enum: ['not_required', 'pending', 'approved', 'rejected'],
        default: 'not_required',
        index: true
    },
    expiresAt: { type: Date, default: null },
    maxDownloads: { type: Number, default: null },
    downloadCount: { type: Number, default: 0 },
    lastDownloadedAt: { type: Date, default: null },
    revoked: { type: Boolean, default: false }
}, { timestamps: true });

shareSchema.index(
    { ownerId: 1, recipientId: 1, itemId: 1, itemType: 1 },
    { unique: true }
);
shareSchema.index({ organizationId: 1, targetType: 1, revoked: 1, expiresAt: 1 });
shareSchema.index({ ownerId: 1, organizationId: 1, revoked: 1, updatedAt: -1 });
shareSchema.index({ workspaceId: 1, revoked: 1, updatedAt: -1 });

module.exports = mongoose.model('Share', shareSchema);
