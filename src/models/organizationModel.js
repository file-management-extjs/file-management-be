const mongoose = require('mongoose');

const organizationSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    description: { type: String, default: '' },
    status: {
        type: String,
        enum: ['active', 'suspended', 'archived'],
        default: 'active',
        index: true
    },
    ownerUserId: { type: String, required: true, index: true },
    settings: {
        type: mongoose.Schema.Types.Mixed,
        default: () => ({})
    }
}, { timestamps: true });

organizationSchema.index({ ownerUserId: 1, status: 1 });

module.exports = mongoose.model('Organization', organizationSchema);
