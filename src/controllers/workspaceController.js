const WorkspaceService = require('../services/workspaceService');

exports.getWorkspaceContext = async (req, res) => {
    try {
        const context = await WorkspaceService.getContext(req.userId, req.query.workspaceId || null);
        res.status(200).json({
            success: true,
            ...context
        });
    } catch (error) {
        console.error('Error fetching workspace context:', error.message);
        res.status(error.statusCode || 500).json({
            success: false,
            message: error.message || 'Failed to fetch workspace context.'
        });
    }
};
