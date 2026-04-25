const mongoose = require('mongoose');

const organizationMemberSchema = new mongoose.Schema({
    organizationId: { type: String, required: true, index: true },
    userId: { type: String, default: null, index: true },
    email: { type: String, default: '', lowercase: true, trim: true },
    displayName: { type: String, default: '' },
    status: {
        type: String,
        enum: ['invited', 'active', 'suspended', 'removed'],
        default: 'active',
        index: true
    },
    roles: {
        type: [String],
        enum: ['owner', 'admin', 'teamAdmin', 'member'],
        default: ['member']
    },
    settings: {
        type: mongoose.Schema.Types.Mixed,
        default: () => ({})
    },
    invitedBy: { type: String, default: null },
    invitedAt: { type: Date, default: null },
    joinedAt: { type: Date, default: Date.now },
    removedAt: { type: Date, default: null }
}, { timestamps: true });

organizationMemberSchema.index(
    { organizationId: 1, userId: 1 },
    { unique: true, partialFilterExpression: { userId: { $type: 'string' } } }
);
organizationMemberSchema.index(
    { organizationId: 1, email: 1 },
    { partialFilterExpression: { email: { $type: 'string' } } }
);
organizationMemberSchema.index({ organizationId: 1, status: 1 });

module.exports = mongoose.model('OrganizationMember', organizationMemberSchema);
