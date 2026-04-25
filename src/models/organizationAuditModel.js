const mongoose = require('mongoose');

const organizationAuditSchema = new mongoose.Schema({
    organizationId: { type: String, required: true, index: true },
    actorUserId: { type: String, default: null, index: true },
    action: { type: String, required: true, index: true },
    entityType: { type: String, required: true, index: true },
    entityId: { type: String, default: null, index: true },
    targetUserId: { type: String, default: null, index: true },
    metadata: {
        type: mongoose.Schema.Types.Mixed,
        default: () => ({})
    }
}, { timestamps: true });

organizationAuditSchema.index({ organizationId: 1, createdAt: -1 });

module.exports = mongoose.model('OrganizationAudit', organizationAuditSchema);
