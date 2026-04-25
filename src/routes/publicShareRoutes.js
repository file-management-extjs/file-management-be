const express = require('express');
const router = express.Router();

const {
    getPublicMetadata,
    verifyPublicPassword,
    getPublicFolderChildren,
    streamPublicContent,
    downloadPublicItem
} = require('../controllers/shareLinkController');

router.get('/:token', getPublicMetadata);
router.post('/:token/password', verifyPublicPassword);
router.get('/:token/children', getPublicFolderChildren);
router.get('/:token/content', streamPublicContent);
router.get('/:token/download', downloadPublicItem);

module.exports = router;
