const express = require('express');
const router = express.Router();
const {
    uploadFiles,
    getFiles,
    downloadFile,
    deleteFile,
    deleteMultipleFiles,
    viewFile,
    createFolder,
    compressFiles,
    decompressFile,
    renameItem,
    moveItem,
    download,
    getFileSize,
    getUploadStatus,
    resetUpload,
    stopCompression,
    getFolderTree,
    getDashboardSummary,
    requestVirusScan,
    shareItem,
    revokeShare,
    setPassword,
    removePassword,
    verifyPassword,
    searchItems,
    updateFileContent,
    revokeItemShares,
    getBackgroundActivity,
    getPrivateVaultStatus,
    setupPrivateVault,
    unlockPrivateVault
} = require('../controllers/fileController');
const {
    createDirectLink,
    revokeItemDirectLinks
} = require('../controllers/shareLinkController');
const {
    getStorageInsights
} = require('../controllers/storageInsightsController');

const multer = require('multer');

const storage = multer.memoryStorage();
const upload = multer({ storage });

router.post('/upload', upload.single('chunk'), uploadFiles);
router.post('/upload/reset', resetUpload);
router.get('/summary', getDashboardSummary);
router.get('/dashboard/summary', getDashboardSummary);
router.get('/background-activity', getBackgroundActivity);
router.get('/storage-insights', getStorageInsights);
router.get('/private-vault/status', getPrivateVaultStatus);
router.post('/private-vault/setup', setupPrivateVault);
router.post('/private-vault/unlock', unlockPrivateVault);
router.post('/scan/:fileId', requestVirusScan);
router.get('/', getFiles);
// router.get('/download/:name', downloadFile);
router.delete('/:id', deleteFile);
router.delete('/', deleteMultipleFiles);
router.get('/view/:fileId', viewFile);
router.put('/content/:fileId', updateFileContent);
router.post('/create-folder', createFolder);
router.post('/compress', compressFiles);
router.post('/decompress', decompressFile);
router.post('/rename', renameItem);
router.post('/move', moveItem);
router.post('/download', download);
router.post('/file-size', getFileSize);
router.post('/share', shareItem);
router.post('/share-link', createDirectLink);
router.delete('/share-link/item/:itemType/:itemId', revokeItemDirectLinks);
router.delete('/share/item/:itemType/:itemId', revokeItemShares);
router.delete('/share/:shareId', revokeShare);
router.get('/upload/status', getUploadStatus);
router.post('/stop-compression', stopCompression);
router.get('/folders/tree', getFolderTree);

// Search files and folders
router.get('/search', searchItems);

// Password protection routes
router.post('/password/set', setPassword);
router.post('/password/remove', removePassword);
router.post('/password/verify', verifyPassword);

module.exports = router;
