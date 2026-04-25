const express = require('express');
const router = express.Router();
const {
    getCapabilities,
    execute
} = require('../controllers/pdfStudioController');

router.get('/capabilities', getCapabilities);
router.post('/execute', execute);

module.exports = router;
