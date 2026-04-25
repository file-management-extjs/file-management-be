const User = require('../models/userModel');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');

const FileService = require('../services/fileService');
const { normalizeUserSettings } = require('../services/userSettingsService');

function emitForceLogout(userId, reason) {
    try {
        const { getIO } = require('../socket');
        getIO().to(userId.toString()).emit('forceLogout', {
            reason: reason || 'LOGGED_OUT'
        });
    } catch (socketError) {
        // Socket may not be initialized in some execution contexts; auth changes should still succeed.
    }
}

function sanitizeIdentity(value) {
    return String(value || '').trim();
}

function publicUserPayload(user) {
    return {
        id: user._id.toString(),
        username: user.username,
        email: user.email,
        settings: normalizeUserSettings(user.settings)
    };
}


exports.register = async (req, res) => {
    try {
        const { username, email, password } = req.body;
        const user = new User({ username, email, password });
        await user.save();

        // Generate the user-specific directory path
        const userBasePath = path.join(FileService.uploadDirectory, user._id.toString());

        // Create the directory if it doesn't exist
        if (!fs.existsSync(userBasePath)) {
            fs.mkdirSync(userBasePath, { recursive: true });
        }

        res.status(201).json({ success: true, message: 'User registered successfully' });
    } catch (error) {
        console.log(error);
        res.status(500).json({ success: false, error: 'Error registering user' });
    }
};

exports.login = async (req, res) => {
    try {
        const { username, password, rememberMe } = req.body;
        const user = await User.findOne({ username });
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ success: false, error: 'Invalid credentials' });
        }

        const shouldRemember = rememberMe === true || rememberMe === 'true' || rememberMe === 'on' || rememberMe === '1' || rememberMe === 1;
        const tokenExpiry = shouldRemember ? '7d' : '1h';

        const token = jwt.sign(
            {
                userId: user._id,
                sessionVersion: user.sessionVersion || 0
            },
            process.env.JWT_SECRET,
            { expiresIn: tokenExpiry }
        );

        res.status(200).json({ 
            success: true, 
            token, 
            username,
            userId: user._id.toString() 
        });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Error logging in' });
    }
};

exports.logout = async (req, res) => {
    try {
        await User.updateOne(
            { _id: req.userId },
            { $inc: { sessionVersion: 1 } }
        );

        emitForceLogout(req.userId, 'LOGGED_OUT');

        res.status(200).json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Error logging out' });
    }
};

exports.me = async (req, res) => {
    try {
        const user = await User.findById(req.userId).select('_id username email settings');
        if (!user) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        res.status(200).json({
            success: true,
            user: publicUserPayload(user)
        });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to load user settings' });
    }
};

exports.updateProfile = async (req, res) => {
    try {
        const username = sanitizeIdentity(req.body.username);
        const email = sanitizeIdentity(req.body.email).toLowerCase();

        if (!username || !email) {
            return res.status(400).json({ success: false, error: 'Username and email are required.' });
        }

        const existingUser = await User.findOne({
            _id: { $ne: req.userId },
            $or: [
                { username },
                { email }
            ]
        }).select('_id username email');

        if (existingUser) {
            const field = existingUser.username === username ? 'Username' : 'Email';
            return res.status(409).json({ success: false, error: `${field} is already in use.` });
        }

        const user = await User.findById(req.userId).select('_id username email settings');
        if (!user) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        user.username = username;
        user.email = email;
        await user.save();

        res.status(200).json({
            success: true,
            user: publicUserPayload(user)
        });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to update profile.' });
    }
};

exports.updateSettings = async (req, res) => {
    try {
        const user = await User.findById(req.userId).select('_id username email settings');
        if (!user) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        user.settings = normalizeUserSettings(req.body.settings || {});
        user.markModified('settings');
        await user.save();

        res.status(200).json({
            success: true,
            settings: normalizeUserSettings(user.settings)
        });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to update settings.' });
    }
};

exports.changePassword = async (req, res) => {
    try {
        const currentPassword = String(req.body.currentPassword || '');
        const newPassword = String(req.body.newPassword || '');

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ success: false, error: 'Current and new password are required.' });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({ success: false, error: 'New password must be at least 6 characters.' });
        }

        const user = await User.findById(req.userId).select('+password');
        if (!user || !(await bcrypt.compare(currentPassword, user.password))) {
            return res.status(401).json({ success: false, error: 'Current password is incorrect.' });
        }

        user.password = newPassword;
        await user.save();

        res.status(200).json({ success: true, message: 'Password updated successfully.' });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to update password.' });
    }
};

exports.logoutAll = async (req, res) => {
    try {
        await User.updateOne(
            { _id: req.userId },
            { $inc: { sessionVersion: 1 } }
        );

        emitForceLogout(req.userId, 'LOGGED_OUT_ALL');
        res.status(200).json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to end sessions.' });
    }
};
