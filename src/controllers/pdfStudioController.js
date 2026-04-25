const PdfStudioService = require('../services/pdfStudioService');

exports.getCapabilities = async (req, res) => {
    res.status(200).json({
        success: true,
        operations: PdfStudioService.supportedOperations,
        tools: {
            pdfcpu: 'Core PDF editing: merge, split, extract, reorder, rotate, watermark, protect, create from images',
            ghostscript: 'PDF compression profiles',
            poppler: 'PDF to images, text, and HTML',
            libreoffice: 'Documents to PDF',
            pdf2docx: 'PDF to Word'
        }
    });
};

exports.execute = async (req, res) => {
    try {
        const result = await PdfStudioService.execute(req.userId, req.body);
        res.status(200).json(result);
    } catch (error) {
        console.error('PDF Studio error:', error);
        res.status(error.statusCode || 500).json({
            success: false,
            error: error.message || 'PDF Studio operation failed.'
        });
    }
};
