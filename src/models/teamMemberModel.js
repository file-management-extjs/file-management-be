const mongoose = require('mongoose');

const teamMemberSchema = new mongoose.Schema({
    organizationId: { type: String, required: true, index: true },
    teamId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    role: {
        type: String,
        enum: ['member', 'admin'],
        default: 'member'
    },
    status: {
        type: String,
        enum: ['active', 'removed'],
        default: 'active',
        index: true
    }
}, { timestamps: true });

teamMemberSchema.index({ teamId: 1, userId: 1 }, { unique: true });
teamMemberSchema.index({ organizationId: 1, userId: 1, status: 1 });

module.exports = mongoose.model('TeamMember', teamMemberSchema);
