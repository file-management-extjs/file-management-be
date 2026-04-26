const mongoose = require('mongoose');

const FILE_TEXT_INDEX_NAME = 'file_content_intelligence_text_index';
const FILE_TEXT_INDEX_SPEC = {
    name: 'text',
    path: 'text',
    'contentIntelligence.searchableText': 'text',
    'contentIntelligence.tags': 'text',
    'contentIntelligence.classification': 'text',
    'contentIntelligence.summary': 'text'
};
const FILE_TEXT_INDEX_OPTIONS = {
    name: FILE_TEXT_INDEX_NAME,
    default_language: 'none',
    language_override: 'fileTextSearchLanguage'
};

const fileSchema = new mongoose.Schema({
    name: { type: String, required: true },
    path: { type: String, required: true },
    storageProvider: { type: String, default: 'local' },
    bucket: { type: String, default: null },
    storageKey: { type: String, default: null },
    mimetype: { type: String },
    size: { type: Number },
    userId: { type: String, required: true },
    workspaceId: { type: String, default: null, index: true },
    workspaceType: {
        type: String,
        enum: ['personal', 'organization', null],
        default: null,
        index: true
    },
    organizationId: { type: String, default: null, index: true },
    createdByUserId: { type: String, default: null, index: true },
    parent_id: { type: String, default: null },
    deleted: { type: Boolean, default: false },
    isPasswordProtected: { type: Boolean, default: false },
    password: { type: String, select: false }, // Will not be included in queries by default
    lastAccessed: { type: Date },
    scanStatus: { 
        type: String, 
        enum: ['pending', 'scanning', 'clean', 'infected', null],
        default: null
    },
    scanProgress: { type: Number, default: 0, min: 0, max: 100 },
    scanResult: {
        type: String,
        default: null
    },
    scanDate: {
        type: Date,
        default: null
    },
    contentIntelligence: {
        status: {
            type: String,
            enum: ['idle', 'queued', 'processing', 'completed', 'failed', 'unsupported', 'cancelled', null],
            default: null
        },
        stage: { type: String, default: null },
        progress: { type: Number, default: 0, min: 0, max: 100 },
        searchableText: { type: String, default: '' },
        textExcerpt: { type: String, default: '' },
        textLength: { type: Number, default: 0 },
        language: { type: String, default: null },
        classification: { type: String, default: null },
        tags: { type: [String], default: [] },
        summary: { type: String, default: '' },
        entities: { type: [String], default: [] },
        provider: { type: String, default: null },
        model: { type: String, default: null },
        extractionMethod: { type: String, default: null },
        ocrProvider: { type: String, default: null },
        ocrModel: { type: String, default: null },
        ocrFallbackApplied: { type: Boolean, default: false },
        ocrError: { type: String, default: null },
        ocrApplied: { type: Boolean, default: false },
        imageRecognized: { type: Boolean, default: false },
        error: { type: String, default: null },
        manuallyTriggered: { type: Boolean, default: false },
        lastRunAt: { type: Date, default: null },
        completedAt: { type: Date, default: null }
    },
    userAccess: [{
        userId: { type: String, required: true },
        lastAccessed: { type: Date, required: true }
    }]
}, { timestamps: true });

// Add index for faster queries
fileSchema.index({ userId: 1, parent_id: 1, deleted: 1 });
fileSchema.index({ userId: 1, deleted: 1, size: -1 });
fileSchema.index({ userId: 1, deleted: 1, mimetype: 1 });
fileSchema.index({ userId: 1, deleted: 1, createdAt: 1 });
fileSchema.index({ userId: 1, deleted: 1, updatedAt: 1, size: -1 });
fileSchema.index({ workspaceId: 1, parent_id: 1, deleted: 1 });
fileSchema.index({ workspaceId: 1, deleted: 1, size: -1 });
fileSchema.index({ workspaceId: 1, deleted: 1, mimetype: 1 });
fileSchema.index({ organizationId: 1, workspaceId: 1, deleted: 1 });
fileSchema.index({ workspaceId: 1, deleted: 1, 'contentIntelligence.status': 1 });
fileSchema.index(FILE_TEXT_INDEX_SPEC, FILE_TEXT_INDEX_OPTIONS);

fileSchema.statics.textSearchIndexName = FILE_TEXT_INDEX_NAME;
fileSchema.statics.textSearchIndexSpec = FILE_TEXT_INDEX_SPEC;
fileSchema.statics.textSearchIndexOptions = FILE_TEXT_INDEX_OPTIONS;

// Middleware to check and reset lastAccessed if more than 1 hour old
fileSchema.pre('save', function(next) {
    if (this.lastAccessed) {
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000); // 1 hour in milliseconds
        if (this.lastAccessed < oneHourAgo) {
            this.lastAccessed = null;
        }
    }
    next();
});

module.exports = mongoose.model('File', fileSchema);
