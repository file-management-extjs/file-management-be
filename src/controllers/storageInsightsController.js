const StorageInsightsService = require('../services/storageInsightsService');

exports.getStorageInsights = async (req, res) => {
    try {
        const insights = await StorageInsightsService.getStorageInsights(req.userId, {
            refresh: req.query.refresh === '1' || req.query.refresh === 'true',
            largestFilesLimit: req.query.largestFilesLimit,
            largestFoldersLimit: req.query.largestFoldersLimit,
            folderVisualizationLimit: req.query.folderVisualizationLimit,
            extensionBreakdownLimit: req.query.extensionBreakdownLimit,
            workspaceId: req.query.workspaceId || null
        });

        res.status(200).json({
            success: true,
            insights
        });
    } catch (error) {
        console.error('Error fetching storage insights:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch storage insights'
        });
    }
};
