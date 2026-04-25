const mongoose = require('mongoose');

const shareLinkSchema = new mongoose.Schema({
    ownerId: { type: String, required: true, index: true },
    workspaceId: { type: String, default: null, index: true },
    workspaceType: { type: String, enum: ['personal', 'organization', null], default: null },
    organizationId: { type: String, default: null, index: true },
    createdByUserId: { type: String, default: null, index: true },
    itemId: { type: String, required: true, index: true },
    itemType: {
        type: String,
        enum: ['file', 'folder'],
        required: true
    },
    tokenHash: { type: String, required: true, unique: true, index: true },
    tokenPreview: { type: String, required: true },
    permission: {
        type: String,
        enum: ['view', 'download'],
        default: 'download'
    },
    expiresAt: { type: Date, default: null },
    revoked: { type: Boolean, default: false, index: true },
    accessCount: { type: Number, default: 0 },
    lastAccessedAt: { type: Date, default: null },
    maxDownloads: { type: Number, default: null },
    downloadCount: { type: Number, default: 0 },
    lastDownloadedAt: { type: Date, default: null }
}, { timestamps: true });

shareLinkSchema.index({ ownerId: 1, itemId: 1, itemType: 1, revoked: 1 });
shareLinkSchema.index({ workspaceId: 1, revoked: 1, updatedAt: -1 });
shareLinkSchema.index({ organizationId: 1, revoked: 1, updatedAt: -1 });

module.exports = mongoose.model('ShareLink', shareLinkSchema);
