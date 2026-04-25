const express = require('express');
const router = express.Router();
const controller = require('../controllers/workspaceController');

router.get('/context', controller.getWorkspaceContext);

module.exports = router;
