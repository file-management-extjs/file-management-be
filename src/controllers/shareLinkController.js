const ShareLinkService = require('../services/shareLinkService');

function getFrontendBaseUrl(req) {
    return (req.get('origin') || process.env.FRONTEND_BASE_URL || 'http://localhost:8082').replace(/\/$/, '');
}

function getPublicUrl(req, token) {
    return `${getFrontendBaseUrl(req)}/share.html?token=${encodeURIComponent(token)}`;
}

function sendShareError(res, error) {
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({
        success: false,
        code: error.code || 'SHARE_ERROR',
        message: error.message || 'Share link request failed.'
    });
}

exports.createDirectLink = async (req, res) => {
    try {
        const { itemId, isFolder, permission, expiresInHours, expiresInMinutes, workspaceId } = req.body;

        const result = await ShareLinkService.createLink(req.userId, itemId, !!isFolder, {
            permission,
            expiresInHours,
            expiresInMinutes,
            workspaceId
        });

        res.status(201).json({
            success: true,
            link: {
                id: result.link._id.toString(),
                url: getPublicUrl(req, result.token),
                permission: result.link.permission,
                expiresAt: result.link.expiresAt,
                tokenPreview: result.link.tokenPreview,
                maxDownloads: result.link.maxDownloads || null,
                downloadCount: result.link.downloadCount || 0,
                requiresPassword: !!result.item.isPasswordProtected,
                itemName: result.item.name,
                itemType: result.link.itemType
            }
        });
    } catch (error) {
        sendShareError(res, error);
    }
};

exports.revokeItemDirectLinks = async (req, res) => {
    try {
        const itemType = req.params.itemType;
        if (!['file', 'folder'].includes(itemType)) {
            return res.status(400).json({ success: false, message: 'Invalid item type' });
        }

        const result = await ShareLinkService.revokeItemLinks(req.userId, req.params.itemId, itemType, {
            workspaceId: req.query.workspaceId || req.body.workspaceId || null
        });
        res.status(200).json(result);
    } catch (error) {
        sendShareError(res, error);
    }
};

exports.getPublicMetadata = async (req, res) => {
    try {
        const metadata = await ShareLinkService.getMetadata(req.params.token);
        res.status(200).json(metadata);
    } catch (error) {
        sendShareError(res, error);
    }
};

exports.verifyPublicPassword = async (req, res) => {
    try {
        const result = await ShareLinkService.verifyPassword(req.params.token, req.body.password);
        res.status(200).json(result);
    } catch (error) {
        sendShareError(res, error);
    }
};

exports.getPublicFolderChildren = async (req, res) => {
    try {
        const accessToken = ShareLinkService.getAccessTokenFromRequest(req);
        const result = await ShareLinkService.getFolderChildren(req.params.token, accessToken);
        res.status(200).json(result);
    } catch (error) {
        sendShareError(res, error);
    }
};

exports.streamPublicContent = async (req, res) => {
    try {
        const accessToken = ShareLinkService.getAccessTokenFromRequest(req);
        const content = await ShareLinkService.getFileContent(req.params.token, accessToken);

        res.setHeader('Content-Type', content.mimeType);
        res.setHeader('Content-Disposition', 'inline');

        content.stream.on('error', (error) => {
            console.error('Public share stream error:', error.message);
            if (!res.headersSent) {
                res.status(500).send('File streaming error');
            }
        });

        content.stream.pipe(res);
    } catch (error) {
        sendShareError(res, error);
    }
};

exports.downloadPublicItem = async (req, res) => {
    try {
        const accessToken = ShareLinkService.getAccessTokenFromRequest(req);
        const download = await ShareLinkService.getDownload(req.params.token, accessToken);

        res.setHeader('Content-Type', download.mimeType);
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(download.fileName)}"`);

        download.stream.on('error', (error) => {
            console.error('Public share download error:', error.message);
            if (!res.headersSent) {
                res.status(500).send('Download failed');
            }
        });

        download.stream.pipe(res);
    } catch (error) {
        sendShareError(res, error);
    }
};
