const MediaConversionService = require('../services/mediaConversionService');
const mediaConversionQueue = require('../queues/mediaConversionQueue');

exports.getCapabilities = async (req, res) => {
    res.status(200).json({
        success: true,
        operations: MediaConversionService.supportedOperations,
        formats: {
            audio: ['mp3', 'aac', 'm4a', 'wav', 'ogg', 'flac'],
            video: ['mp4', 'webm', 'mov', 'mkv', 'avi'],
            image: ['png', 'jpg', 'webp', 'avif'],
            presets: ['low', 'balanced', 'high', 'source'],
            resolutions: ['source', '2160p', '1440p', '1080p', '720p', '480p', '360p']
        }
    });
};

exports.execute = async (req, res) => {
    try {
        const { sourceFile } = await MediaConversionService.validateRequest(req.userId, req.body);
        const progressId = req.body.progressId || `media-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const job = await mediaConversionQueue.add({
            userId: req.userId,
            payload: req.body,
            progressId,
            fileName: sourceFile.name
        });

        res.status(202).json({
            success: true,
            message: 'Media conversion queued.',
            jobId: job.id,
            progressId
        });
    } catch (error) {
        console.error('Media Conversion Hub error:', error);
        res.status(error.statusCode || 500).json({
            success: false,
            error: error.message || 'Media conversion failed.',
            message: error.message || 'Media conversion failed.',
            code: error.code
        });
    }
};

exports.cancel = async (req, res) => {
    try {
        const cancelled = await mediaConversionQueue.cancelJob(req.body.jobId, req.body.progressId);

        if (!cancelled) {
            res.status(404).json({
                success: false,
                error: 'Media conversion job not found or already completed.'
            });
            return;
        }

        res.status(200).json({
            success: true,
            message: 'Media conversion cancellation requested.'
        });
    } catch (error) {
        console.error('Media conversion cancellation error:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to cancel media conversion.'
        });
    }
};

exports.getStatus = async (req, res) => {
    try {
        const status = await mediaConversionQueue.getStatus(req.params.jobId);

        if (!status) {
            res.status(404).json({
                success: false,
                error: 'Media conversion job not found.'
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
            error: error.message || 'Failed to read media conversion status.'
        });
    }
};
