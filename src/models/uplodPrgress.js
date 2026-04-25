const mongoose = require('mongoose');

const uploadProgressSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    workspaceId: { type: String, default: null, index: true },
    workspaceType: {
        type: String,
        enum: ['personal', 'organization', null],
        default: null,
        index: true
    },
    organizationId: { type: String, default: null, index: true },
    filename: { type: String, required: true },
    folderId: { type: String, default: null },
    fileSize: { type: Number, default: null },
    totalChunks: { type: Number, default: null },
    uploadedChunks: { type: [Number], default: [] }, // List of chunk indices already uploaded
    createdAt: { type: Date, default: Date.now }
});

uploadProgressSchema.index({ userId: 1, workspaceId: 1, filename: 1, folderId: 1 }, { unique: true });
uploadProgressSchema.index({ userId: 1, createdAt: -1 });
uploadProgressSchema.index({ workspaceId: 1, createdAt: -1 });

module.exports = mongoose.model('UploadProgress', uploadProgressSchema);
