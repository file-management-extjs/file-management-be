const FileService = require('../services/fileService');
const ScanningService = require('../services/scanningService');
const path = require('path');
const fs = require('fs');
const { getIO } = require('../socket');
const SearchService = require('../services/searchService');
const BackgroundActivityService = require('../services/backgroundActivityService');
const backgroundOperationRegistry = require('../services/backgroundOperationRegistry');

function parseRangeHeader(rangeHeader) {
    const match = String(rangeHeader || '').match(/^bytes=(\d+)-(\d+)?$/);
    if (!match) {
        return null;
    }

    const start = parseInt(match[1], 10);
    const end = match[2] !== undefined ? parseInt(match[2], 10) : null;

    if (!Number.isFinite(start) || start < 0 || (end !== null && (!Number.isFinite(end) || end < start))) {
        return null;
    }

    return { start, end };
}

exports.uploadFiles = async (req, res) => {
    try {
        const { filename, currentChunk, totalChunks, folderId, fileSize, workspaceId } = req.body;
        const chunk = req.file; // Assuming you're using multer or similar middleware

        if (!filename || currentChunk == null || totalChunks == null || !chunk) {
            return res.status(400).json({ error: 'Missing required parameters or file chunk' });
        }

        const userId = req.userId; // Assuming userId is attached by middleware

        // Delegate chunk processing and progress tracking to FileService
        await FileService.processChunkAndTrackProgress(userId, filename, folderId, chunk, currentChunk, totalChunks, fileSize, {
            workspaceId
        });

        return res.status(200).json({ message: 'Chunk uploaded successfully', currentChunk });
    } catch (error) {
        console.error('Error uploading chunk:', error);
        return res.status(500).json({ error: 'Failed to upload chunk' });
    }
};

// Get all files
exports.getFiles = async (req, res) => {
    const userId = req.userId; // Assuming authentication middleware
    const parentId = req.query.parent_id || null;
    const search = req.query.search || null;
    const shared = req.query.shared === 'true';
    const sharedByMe = req.query.sharedByMe === 'true';
    const workspaceId = req.query.workspaceId || null;

    try {
        res.setHeader('Content-Type', 'application/json');
        res.write('['); // Start JSON array
        let isFirst = true;

        for await (const record of FileService.streamFilesGenerator(userId, parentId, search, { shared, sharedByMe, workspaceId })) {
            if (!isFirst) res.write(',');
            res.write(JSON.stringify(record));
            isFirst = false;
        }

        res.write(']'); // Close JSON array
        res.end();
    } catch (error) {
        console.error('Error in getFiles controller:', error);
        res.status(500).json({ error: 'Failed to fetch files and folders' });
    }
};

exports.getDashboardSummary = async (req, res) => {
    try {
        const summary = await FileService.getDashboardSummary(req.userId, {
            workspaceId: req.query.workspaceId || null
        });
        res.status(200).json({ success: true, summary });
    } catch (error) {
        console.error('Error fetching dashboard summary:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch dashboard summary' });
    }
};

exports.requestVirusScan = async (req, res) => {
    try {
        const result = await ScanningService.requestFileScan(req.userId, req.params.fileId);

        res.status(200).json({
            success: true,
            ...result
        });
    } catch (error) {
        console.error('Error requesting virus scan:', error);
        res.status(error.statusCode || 500).json({
            success: false,
            error: error.message || 'Failed to request virus scan.'
        });
    }
};


// Download file
exports.downloadFile = async (req, res) => {
    try {
        const filePath = await FileService.getFile(req.userId, req.params.filename);
        res.download(filePath);
    } catch (err) {
        res.status(404).json({ error: err.message });
    }
};

// View file
exports.viewFile = async (req, res) => {
    try {
        const { file, filePath, mimeType } = await FileService.viewFile(req.userId, req.params.fileId);

        if (mimeType) {
            res.setHeader('Content-Type', mimeType);
        }

        if (['application/pdf'].includes(mimeType)) {
            res.setHeader('Content-Disposition', 'inline');
        }

        const { stream } = await FileService.getFileStream(file || filePath);

        if (!stream) {
            throw new Error('Failed to create file stream');
        }

        stream.on('error', (error) => {
            console.error('File streaming error:', error.message);
            res.status(500).send('File streaming error');
        });

        stream.on('end', () => {
            console.log('File stream ended');
        });

        stream.pipe(res).on('finish', () => {
            console.log('Response stream finished');
        });

    } catch (err) {
        const status = err.message === 'Password verification required'
            ? 401
            : (err.statusCode || 404);
        res.status(status).json({ error: err.message });
    }
};

// Function to delete a single file
exports.deleteFile = async (req, res) => {
    try {
        await FileService.deleteFile(req.userId, req.params.id, { workspaceId: req.query.workspaceId || req.body.workspaceId || null });
        res.json({ success: true, message: 'File deleted successfully.' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to delete file.' });
    }
};

// Function to delete multiple files
exports.deleteMultipleFiles = async (req, res) => {
    const { ids, parentId, workspaceId } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ success: false, message: 'No file IDs provided.' });
    }

    try {
        const deletedCount = await FileService.deleteMultipleFiles(req.userId, ids, parentId, { workspaceId });

        return res.json({ success: true, message: 'Files deleted successfully.', deletedCount });
        // if (deletedCount > 0) {
        //     return res.json({ success: true, message: 'Files deleted successfully.', deletedCount });
        // } else {
        //     return res.status(404).json({ success: false, message: 'No files found for the provided IDs.' });
        // }
    } catch (error) {
        console.log(error);
        res.status(500).json({ success: false, message: 'An error occurred while deleting files.' });
    }
};

exports.createFolder = async (req, res) => {
    const { name, parentId } = req.body;

    if (!name) {
        return res.status(400).json({ error: 'Folder name is required' });
    }

    try {
        await FileService.createFolder(req.userId, name, parentId, { workspaceId: req.body.workspaceId || null });
        res.status(201).json({ message: 'Folder created successfully' });
    } catch (error) {
        console.error('Error creating folder:', error);
        res.status(500).json({ error: `Failed to create folder: ${error.message}` });
    }
};

exports.compressFiles = async (req, res) => {
    try {
        const userId = req.userId; 
        const { items, folder, parentId, zipFileName, archiveType, compressionLevel, progressId, affectedItems, workspaceId } = req.body;

        // Validate request
        if (!items || !Array.isArray(items)) {
            return res.status(400).json({ error: 'Invalid items array' });
        }

        console.log('Creating compression job:', {
            progressId,
            zipFileName,
            items: items.length
        });

        // Add job to compression queue
        const compressionQueue = require('../queues/compressionQueue');
        const job = await compressionQueue.add({
            userId,
            items,
            folder,
            zipFileName,
            parentId,
            archiveType,
            compressionLevel,
            progressId,
            affectedItems,
            workspaceId
        });

        console.log('Created compression job:', {
            jobId: job.id,
            progressId,
            zipFileName
        });

        // Return job ID immediately
        res.json({ 
            success: true, 
            message: 'Compression started',
            jobId: job.id,
            progressId
        });
    } catch (error) {
        console.error('Error in compression:', error);
        res.status(500).json({ error: error.message });
    }
};

exports.decompressFile = async (req, res) => {
    let operationProgressId = null;

    try {
        const { filePath, parentId, progressId, workspaceId } = req.body;

        if (!filePath) {
            return res.status(400).json({ error: 'filePath is required' });
        }

        operationProgressId = progressId || `extraction-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const fileName = path.basename(filePath);

        backgroundOperationRegistry.start({
            userId: req.userId,
            progressId: operationProgressId,
            type: 'Extraction',
            title: `Extracting ${fileName}`,
            detail: 'Archive extraction',
            affectedFiles: [{
                name: fileName,
                fileName,
                path: filePath,
                status: 'Extracting'
            }]
        });

        console.log('Decompressing file:', filePath, 'with parentId:', parentId); // Debugging line
        const result = await FileService.decompressFile(req.userId, filePath, null, parentId, {
            workspaceId,
            progressId: operationProgressId,
            onProgress: (payload) => {
                backgroundOperationRegistry.update(operationProgressId, {
                    progress: payload.progress,
                    status: 'running',
                    statusText: 'Extracting'
                });
            }
        });
        backgroundOperationRegistry.complete(operationProgressId, {
            statusText: 'Extracted'
        });
        res.status(200).json(result);
    } catch (error) {
        console.error('Error decompressing file:', error);
        if (operationProgressId) {
            backgroundOperationRegistry.fail(operationProgressId, {
                statusText: 'Failed',
                detail: error.message
            });
        }
        res.status(500).json({ error: error.message });
    }
};

exports.stopCompression = async (req, res) => {
    try {
        const { jobId, progressId } = req.body;

        if (!jobId && !progressId) {
            return res.status(400).json({ error: 'jobId or progressId is required.' });
        }

        const compressionQueue = require('../queues/compressionQueue');
        console.log('Attempting to cancel job:', { jobId, progressId });

        // Use the new cancelJob function that handles both active and queued jobs
        const cancelled = await compressionQueue.cancelJob(jobId, progressId);

        if (cancelled) {
            res.status(200).json({ 
                success: true,
                message: 'Compression job cancelled successfully.',
                jobId,
                progressId
            });
        } else {
            console.log('No job found with identifiers:', { jobId, progressId });
            res.status(404).json({ 
                success: false, 
                error: 'No compression job found with the specified ID.' 
            });
        }
    } catch (error) {
        console.error('Error cancelling compression:', error);
        res.status(500).json({ error: 'Failed to cancel compression job.' });
    }
};

exports.renameItem = async (req, res) => {
    try {
        await FileService.renameItem(req.userId, req.body.itemId, req.body.newName, req.body.isFolder, {
            workspaceId: req.body.workspaceId || null
        });
        res.json({ success: true, message: 'File/Folder renamed successfully.' });
    } catch (err) {
        res.status(500).json({ success: false, message: `Failed to rename file/folder: ${err.message}` });
    }
};

exports.updateFileContent = async (req, res) => {
    try {
        const { content } = req.body;

        if (typeof content !== 'string') {
            return res.status(400).json({ success: false, message: 'Content must be a string.' });
        }

        const file = await FileService.updateFileContent(req.userId, req.params.fileId, content);
        res.json({
            success: true,
            message: 'File updated successfully.',
            file
        });
    } catch (error) {
        if (error.message === 'Password verification required') {
            return res.status(401).json({ success: false, message: error.message });
        }

        res.status(error.statusCode || 400).json({ success: false, message: error.message });
    }
};

exports.moveItem = async (req, res) => {
    const { itemIds, targetId, isTargetZip, progressId, workspaceId } = req.body;
    const operationProgressId = progressId || `moving-${Date.now()}`;

    try {
        backgroundOperationRegistry.start({
            userId: req.userId,
            progressId: operationProgressId,
            type: 'Move',
            title: `Moving ${(itemIds || []).length} item${(itemIds || []).length === 1 ? '' : 's'}`,
            detail: 'Moving items between folders',
            affectedFiles: (itemIds || []).map(itemId => ({
                name: itemId,
                fileName: itemId,
                status: 'Queued'
            }))
        });

        const progressCallback = (itemName, progress) => {
            const io = getIO();
            backgroundOperationRegistry.update(operationProgressId, {
                progress,
                status: 'running',
                statusText: 'Moving',
                detail: itemName ? `Moving ${itemName}` : 'Moving items'
            });
            io.to(req.userId.toString()).emit('movingProgress', { itemName, progress, progressId: operationProgressId });
        };

        if (isTargetZip) {
            const result = await FileService.moveItemsIntoZip(req.userId, itemIds, targetId, { workspaceId });
            backgroundOperationRegistry.complete(operationProgressId, {
                statusText: 'Moved'
            });
            res.status(200).json({ success: true, message: 'Items moved into ZIP file successfully', result });
        } else {
            const result = await FileService.moveItems(req.userId, itemIds, targetId, progressCallback, { workspaceId });
            backgroundOperationRegistry.complete(operationProgressId, {
                statusText: 'Moved'
            });
            res.status(200).json({ success: true, message: 'Items moved successfully', result });
        }
    } catch (error) {
        console.error('Error moving items:', error.message);
        backgroundOperationRegistry.fail(operationProgressId, {
            statusText: 'Failed',
            detail: error.message
        });
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.getBackgroundActivity = async (req, res) => {
    try {
        res.status(200).json(await BackgroundActivityService.getState(req.userId));
    } catch (error) {
        console.error('Error fetching background activity:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to fetch background activity.'
        });
    }
};


exports.download = async (req, res) => {
    const fileRef = {
        fileId: req.body.fileId || req.body.id || null,
        filePath: req.body.filePath || req.body.path || null
    };
    const requestedRange = parseRangeHeader(req.headers.range);
    const offset = requestedRange
        ? requestedRange.start
        : (parseInt(req.query.offset, 10) || 0);
    const requestedChunkSize = requestedRange && requestedRange.end !== null
        ? requestedRange.end - requestedRange.start + 1
        : parseInt(req.query.chunkSize, 10);
    const chunkSize = Number.isFinite(requestedChunkSize) && requestedChunkSize > 0
        ? requestedChunkSize
        : 1024 * 1024; // Default 1MB

    console.log('Download request:', {
        fileId: fileRef.fileId,
        filePath: fileRef.filePath,
        offset,
        chunkSize
    });

    try {
        const download = await FileService.prepareDownload(req.userId, fileRef, offset, chunkSize, {
            trackDownload: offset === 0
        });

        // If offset equals file size, return a completed response
        if (offset >= download.fileSize) {
            console.log('Download complete - offset matches or exceeds file size:', {
                offset,
                fileSize: download.fileSize
            });
            return res.status(204).end(); // No Content - indicates successful completion
        }
        
        console.log('Chunk details:', {
            fileSize: download.fileSize,
            start: download.start,
            end: download.end,
            contentLength: download.contentLength,
            isLastChunk: download.end === download.fileSize - 1
        });

        res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': download.contentLength,
            'Accept-Ranges': 'bytes',
            'Content-Range': `bytes ${download.start}-${download.end}/${download.fileSize}`
        });

        download.stream.pipe(res);
    } catch (error) {
        console.error('Error during download:', error);
        const status = error.message === 'Password verification required'
            ? 401
            : error.message === 'Download access denied' ? 403 : (error.statusCode || 500);
        res.status(status).send(error.message || 'Failed to download file.');
    }
};

exports.getFileSize = async (req, res) => {
    try {
        const fileSize = await FileService.getStoredFileSizeByPath(req.userId, {
            fileId: req.body.fileId || req.body.id || null,
            filePath: req.body.filePath || req.body.path || null
        });
        res.json({ success: true, fileSize });
    } catch (error) {
        console.error('Error fetching file size:', error.message);
        const status = error.message === 'Password verification required'
            ? 401
            : error.message === 'Download access denied' ? 403 : 500;
        res.status(status).json({success: false, message: 'Failed to retrieve file size.'});
    }
};

exports.getUploadStatus = async (req, res) => {
    const { filename, folderId, totalChunks, fileSize, workspaceId } = req.query;

    try {
        if (!filename) {
            return res.status(400).json({ message: 'Filename is required.' });
        }

        // Query the database or storage system for uploaded chunks
        const uploadStatus = await FileService.getUploadedChunks(
            filename,
            req.userId,
            folderId,
            totalChunks,
            fileSize,
            { workspaceId }
        );

        if (!uploadStatus) {
            return res.status(404).json({ success: true, message: 'No upload progress found for the specified file.' });
        }

        res.status(200).json(uploadStatus); // Return the list of uploaded chunks
    } catch (error) {
        console.error('Error fetching upload status:', error.message);
        res.status(500).json({ success: false, message: 'Failed to fetch upload status.' });
    }
};

exports.resetUpload = async (req, res) => {
    const { filename, folderId, workspaceId } = req.body;

    try {
        if (!filename) {
            return res.status(400).json({ success: false, message: 'Filename is required.' });
        }

        await FileService.cleanupPartialUpload(req.userId, filename, folderId, { workspaceId });
        return res.status(200).json({ success: true, message: 'Upload session reset successfully.' });
    } catch (error) {
        console.error('Error resetting upload session:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to reset upload session.' });
    }
};

exports.getFolderTree = async (req, res) => {
    try {
        const tree = await FileService.getFolderTree(req.userId, req.query.parentId, true, {
            workspaceId: req.query.workspaceId || null
        }); // Start from root
        res.status(200).json({ success: true, folders: tree });
    } catch (error) {
        console.error('Error fetching folder tree:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch folder tree' });
    }
};

exports.shareItem = async (req, res) => {
    try {
        const { itemId, isFolder, recipient, permission, expiresInHours, expiresInMinutes, workspaceId } = req.body;
        const share = await FileService.shareItem(req.userId, itemId, !!isFolder, recipient, permission, {
            expiresInHours,
            expiresInMinutes,
            workspaceId
        });
        res.status(201).json({ success: true, share });
    } catch (error) {
        console.error('Error sharing item:', error.message);
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.revokeShare = async (req, res) => {
    try {
        await FileService.revokeShare(req.userId, req.params.shareId);
        res.status(200).json({ success: true });
    } catch (error) {
        console.error('Error revoking share:', error.message);
        res.status(400).json({ success: false, message: error.message });
    }
};

exports.revokeItemShares = async (req, res) => {
    try {
        const itemType = req.params.itemType;
        if (!['file', 'folder'].includes(itemType)) {
            return res.status(400).json({ success: false, message: 'Invalid item type' });
        }

        const result = await FileService.revokeItemShares(req.userId, req.params.itemId, itemType === 'folder', {
            workspaceId: req.query.workspaceId || req.body.workspaceId || null
        });
        res.status(200).json(result);
    } catch (error) {
        console.error('Error revoking item shares:', error.message);
        res.status(400).json({ success: false, message: error.message });
    }
};

// Set password protection
exports.setPassword = async (req, res) => {
    try {
        const { itemId, password, isFolder } = req.body;
        const result = await FileService.setPassword(req.userId, itemId, password, isFolder);
        res.json(result);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

// Remove password protection
exports.removePassword = async (req, res) => {
    try {
        const { itemId, currentPassword, isFolder } = req.body;
        const result = await FileService.removePassword(req.userId, itemId, currentPassword, isFolder);
        res.json(result);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

// Verify password for protected item
exports.verifyPassword = async (req, res) => {
    try {
        const { itemId, password, isFolder } = req.body;
        const result = await FileService.verifyPassword(req.userId, itemId, password, isFolder);
        if (result) {
            res.status(204).send();
        } else {
            res.status(401).json({ message: 'Invalid password' });
        }
    } catch (error) {
        console.error('Error verifying password:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

exports.searchItems = async (req, res) => {
    try {
        const { query, workspaceId } = req.query;
        console.log('Search query:', query);
        console.log('User:', req.userId);

        if (!query) {
            return res.status(400).json({ message: 'Search query is required' });
        }

        const results = await SearchService.searchItems(req.userId, query, 10, { workspaceId: workspaceId || null });
        console.log('Search results:', results);
        res.json({ results });
    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ message: 'Failed to search items' });
    }
};
