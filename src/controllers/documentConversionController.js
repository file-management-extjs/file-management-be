const DocumentConversionService = require('../services/documentConversionService');
const documentConversionQueue = require('../queues/documentConversionQueue');

exports.getCapabilities = async (req, res) => {
    res.status(200).json({
        success: true,
        targetFormats: DocumentConversionService.getTargetFormats(),
        features: [
            'DOC, DOCX, ODT, RTF to PDF and text formats',
            'XLS, XLSX, ODS, CSV to PDF and spreadsheet outputs',
            'PPT, PPTX, ODP to PDF and PPTX',
            'TXT, HTML, Markdown to PDF and text outputs',
            'PDF to DOCX, XLSX, PPTX, TXT, Markdown, RTF, CSV',
            'Self-contained HTML web previews',
            'Batch conversion'
        ]
    });
};

exports.execute = async (req, res) => {
    try {
        const validation = await DocumentConversionService.validateRequest(req.userId, req.body);
        const progressId = req.body.progressId || `doc-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const batchLabel = DocumentConversionService.buildBatchLabel(validation.files, validation.targetFormat);
        const job = await documentConversionQueue.add({
            userId: req.userId,
            payload: req.body,
            progressId,
            targetFormat: validation.targetFormat,
            batchLabel
        });

        res.status(202).json({
            success: true,
            message: 'Document conversion queued.',
            jobId: job.id,
            progressId,
            batchLabel
        });
    } catch (error) {
        console.error('Document Conversion Suite error:', error);
        res.status(error.statusCode || 500).json({
            success: false,
            error: error.message || 'Document conversion failed.'
        });
    }
};

exports.cancel = async (req, res) => {
    try {
        const cancelled = await documentConversionQueue.cancelJob(req.body.jobId, req.body.progressId);

        if (!cancelled) {
            res.status(404).json({
                success: false,
                error: 'Document conversion job not found or already completed.'
            });
            return;
        }

        res.status(200).json({
            success: true,
            message: 'Document conversion cancellation requested.'
        });
    } catch (error) {
        console.error('Document conversion cancellation error:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to cancel document conversion.'
        });
    }
};

exports.getStatus = async (req, res) => {
    try {
        const status = await documentConversionQueue.getStatus(req.params.jobId);

        if (!status) {
            res.status(404).json({
                success: false,
                error: 'Document conversion job not found.'
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
            error: error.message || 'Failed to read document conversion status.'
        });
    }
};
