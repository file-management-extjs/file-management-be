const ImageService = require('../services/imageService');

exports.convertImage = async (req, res) => {
    const { fileId, targetFormat, quality } = req.body;

    if (!fileId || !targetFormat) {
        return res.status(400).json({ error: 'Missing required parameters.' });
    }

    try {
        const result = await ImageService.convertImage(req.userId, fileId, targetFormat, quality);
        return res.status(200).json(result);
    } catch (error) {
        console.error('Image conversion error:', error);
        return res.status(error.statusCode || 500).json({
            error: error.message || 'Image conversion failed.'
        });
    }
};
