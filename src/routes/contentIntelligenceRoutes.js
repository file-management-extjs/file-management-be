const express = require('express');
const router = express.Router();
const {
    getSettings,
    saveSettings,
    getFileCapabilities,
    extractFile,
    getJobStatus
} = require('../controllers/contentIntelligenceController');

router.get('/settings', getSettings);
router.put('/settings', saveSettings);
router.get('/files/:fileId/capabilities', getFileCapabilities);
router.post('/files/:fileId/extract', extractFile);
router.get('/jobs/:jobId', getJobStatus);

module.exports = router;
