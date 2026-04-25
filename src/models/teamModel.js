const mongoose = require('mongoose');

const teamSchema = new mongoose.Schema({
    organizationId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    status: {
        type: String,
        enum: ['active', 'inactive', 'deleted'],
        default: 'active',
        index: true
    },
    adminUserIds: { type: [String], default: [] },
    settings: {
        type: mongoose.Schema.Types.Mixed,
        default: () => ({})
    },
    createdBy: { type: String, default: null }
}, { timestamps: true });

teamSchema.index({ organizationId: 1, name: 1, status: 1 });

module.exports = mongoose.model('Team', teamSchema);
