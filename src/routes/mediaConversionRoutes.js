const express = require('express');
const router = express.Router();
const {
    getCapabilities,
    execute,
    cancel,
    getStatus
} = require('../controllers/mediaConversionController');

router.get('/capabilities', getCapabilities);
router.post('/execute', execute);
router.get('/jobs/:jobId', getStatus);
router.post('/jobs/cancel', cancel);

module.exports = router;
