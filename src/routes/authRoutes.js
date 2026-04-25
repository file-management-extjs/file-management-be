const express = require('express');
const {
    register,
    login,
    logout,
    me,
    updateProfile,
    updateSettings,
    changePassword,
    logoutAll
} = require('../controllers/userController');
const auth = require('../middlewares/auth');

const router = express.Router();

router.post('/register', register);
router.post('/login', login);
router.get('/me', auth, me);
router.put('/profile', auth, updateProfile);
router.put('/settings', auth, updateSettings);
router.put('/password', auth, changePassword);
router.post('/logout-all', auth, logoutAll);
router.post('/logout', auth, logout);

module.exports = router;
