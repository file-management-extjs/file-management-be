const mongoose = require('mongoose');

const activityEventSchema = new mongoose.Schema({
    userId: { type: String, required: true, index: true },
    source: { type: String, default: 'event', index: true },
    activityType: { type: String, required: true, index: true },
    iconCls: { type: String, default: 'fa fa-circle-info blue-icon' },
    title: { type: String, required: true },
    detail: { type: String, default: '' },
    status: { type: String, default: 'completed', index: true },
    statusText: { type: String, default: 'Completed' },
    statusGroup: { type: String, default: 'completed', index: true },
    progress: { type: Number, default: 100, min: 0, max: 100 },
    affectedFiles: {
        type: [mongoose.Schema.Types.Mixed],
        default: () => []
    },
    affectedFileCount: { type: Number, default: 0 },
    relatedEntityType: { type: String, default: null, index: true },
    relatedEntityId: { type: String, default: null, index: true },
    metadata: {
        type: mongoose.Schema.Types.Mixed,
        default: () => ({})
    }
}, { timestamps: true });

activityEventSchema.index({ userId: 1, updatedAt: -1 });
activityEventSchema.index({ userId: 1, activityType: 1, updatedAt: -1 });

module.exports = mongoose.model('ActivityEvent', activityEventSchema);
