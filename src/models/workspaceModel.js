const mongoose = require('mongoose');

const workspaceSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    type: {
        type: String,
        enum: ['personal', 'organization'],
        required: true,
        index: true
    },
    ownerUserId: { type: String, default: null, index: true },
    organizationId: { type: String, default: null, index: true },
    rootPath: { type: String, required: true, unique: true },
    status: {
        type: String,
        enum: ['active', 'suspended', 'archived'],
        default: 'active',
        index: true
    },
    settings: {
        type: mongoose.Schema.Types.Mixed,
        default: () => ({})
    }
}, { timestamps: true });

workspaceSchema.index(
    { type: 1, ownerUserId: 1 },
    {
        unique: true,
        partialFilterExpression: { type: 'personal', ownerUserId: { $type: 'string' } }
    }
);
workspaceSchema.index(
    { type: 1, organizationId: 1 },
    {
        unique: true,
        partialFilterExpression: { type: 'organization', organizationId: { $type: 'string' } }
    }
);

module.exports = mongoose.model('Workspace', workspaceSchema);
