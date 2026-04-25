const jwt = require('jsonwebtoken');
const User = require('../models/userModel');

module.exports = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
        return res.status(401).json({
            success: false,
            code: 'TOKEN_MISSING',
            error: 'No token provided'
        });
    }

    const token = authHeader.split(' ')[1]; // Extract the token after 'Bearer'
    if (!token) {
        return res.status(401).json({
            success: false,
            code: 'TOKEN_MALFORMED',
            error: 'Token is malformed'
        });
    }

    jwt.verify(token, process.env.JWT_SECRET, async (err, decoded) => {
        if (err) {
            const expired = err.name === 'TokenExpiredError';
            return res.status(401).json({
                success: false,
                code: expired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID',
                error: expired ? 'Session expired' : 'Failed to authenticate token',
                expiredAt: expired ? err.expiredAt : undefined
            });
        }

        try {
            const user = await User.findById(decoded.userId).select('_id sessionVersion').lean();
            const tokenSessionVersion = Number(decoded.sessionVersion || 0);
            const currentSessionVersion = Number(user && user.sessionVersion || 0);

            if (!user || tokenSessionVersion !== currentSessionVersion) {
                return res.status(401).json({
                    success: false,
                    code: 'TOKEN_INVALIDATED',
                    error: 'Session was logged out'
                });
            }

            req.userId = decoded.userId;
            next();
        } catch (error) {
            return res.status(500).json({
                success: false,
                code: 'AUTH_CHECK_FAILED',
                error: 'Failed to validate session'
            });
        }
    });
};
