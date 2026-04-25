const express = require('express');
const router = express.Router();
const {
    getCapabilities,
    execute,
    cancel,
    getStatus
} = require('../controllers/documentConversionController');

router.get('/capabilities', getCapabilities);
router.post('/execute', execute);
router.get('/jobs/:jobId', getStatus);
router.post('/jobs/cancel', cancel);

module.exports = router;
