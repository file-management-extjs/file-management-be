const File = require('../models/fileModel');
const WorkspaceService = require('../services/workspaceService');
const ContentIntelligenceService = require('../services/contentIntelligenceService');
const contentIntelligenceQueue = require('../queues/contentIntelligenceQueue');

exports.getSettings = async (req, res) => {
    try {
        const result = await ContentIntelligenceService.getWorkspaceSettings(req.userId, req.query.workspaceId || null);
        res.status(200).json({
            success: true,
            ...result
        });
    } catch (error) {
        console.error('Error fetching content intelligence settings:', error);
        res.status(error.statusCode || 500).json({
            success: false,
            error: error.message || 'Failed to fetch content intelligence settings.'
        });
    }
};

exports.saveSettings = async (req, res) => {
    try {
        const result = await ContentIntelligenceService.saveWorkspaceSettings(
            req.userId,
            req.query.workspaceId || req.body.workspaceId || null,
            req.body.settings || req.body
        );
        res.status(200).json({
            success: true,
            ...result
        });
    } catch (error) {
        console.error('Error saving content intelligence settings:', error);
        res.status(error.statusCode || 500).json({
            success: false,
            error: error.message || 'Failed to save content intelligence settings.'
        });
    }
};

exports.getFileCapabilities = async (req, res) => {
    try {
        const context = await WorkspaceService.assertWorkspaceAccess(req.userId, req.query.workspaceId || null);
        const file = await File.findOne({
            _id: req.params.fileId,
            workspaceId: context.workspace._id.toString(),
            deleted: false
        }).lean();

        if (!file) {
            res.status(404).json({
                success: false,
                error: 'File not found or access denied.'
            });
            return;
        }

        const settings = await ContentIntelligenceService.getSettingsForWorkspace(context.workspace._id.toString());
        const capability = ContentIntelligenceService.getFileCapability(file, settings);
        res.status(200).json({
            success: true,
            fileId: file._id.toString(),
            fileName: file.name,
            ...capability,
            status: file.contentIntelligence && file.contentIntelligence.status || null
        });
    } catch (error) {
        console.error('Error fetching content intelligence capabilities:', error);
        res.status(error.statusCode || 500).json({
            success: false,
            error: error.message || 'Failed to fetch content intelligence capabilities.'
        });
    }
};

exports.extractFile = async (req, res) => {
    try {
        const result = await contentIntelligenceQueue.queueFileExtraction({
            userId: req.userId,
            fileId: req.params.fileId,
            workspaceId: req.query.workspaceId || req.body.workspaceId || null,
            manual: true,
            progressId: req.body.progressId || null
        });

        res.status(result.queued ? 202 : 200).json({
            success: true,
            message: result.message || 'Content intelligence request accepted.',
            ...result
        });
    } catch (error) {
        console.error('Error queueing content intelligence extraction:', error);
        res.status(error.statusCode || 500).json({
            success: false,
            error: error.message || 'Failed to queue content intelligence extraction.'
        });
    }
};

exports.getJobStatus = async (req, res) => {
    try {
        const status = await contentIntelligenceQueue.getStatus(req.params.jobId);

        if (!status) {
            res.status(404).json({
                success: false,
                error: 'Content intelligence job not found.'
            });
            return;
        }

        res.status(200).json({
            success: true,
            ...status
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to read content intelligence job status.'
        });
    }
};
