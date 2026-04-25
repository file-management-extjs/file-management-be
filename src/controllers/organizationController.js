const OrganizationService = require('../services/organizationService');
const OrganizationShareService = require('../services/organizationShareService');

function sendError(res, error) {
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({
        success: false,
        code: error.code || 'ORGANIZATION_ERROR',
        message: error.message || 'Organization request failed.'
    });
}

exports.getContext = async (req, res) => {
    try {
        res.status(200).json({
            success: true,
            context: await OrganizationService.getContext(req.userId, req.query.orgId || null)
        });
    } catch (error) {
        sendError(res, error);
    }
};

exports.createOrganization = async (req, res) => {
    try {
        res.status(201).json({
            success: true,
            context: await OrganizationService.createOrganization(req.userId, req.body)
        });
    } catch (error) {
        sendError(res, error);
    }
};

exports.acceptInvitation = async (req, res) => {
    try {
        res.status(200).json({
            success: true,
            context: await OrganizationService.acceptInvitation(req.userId, req.params.membershipId)
        });
    } catch (error) {
        sendError(res, error);
    }
};

exports.declineInvitation = async (req, res) => {
    try {
        res.status(200).json({
            success: true,
            context: await OrganizationService.declineInvitation(req.userId, req.params.membershipId)
        });
    } catch (error) {
        sendError(res, error);
    }
};

exports.getOrganization = async (req, res) => {
    try {
        res.status(200).json({
            success: true,
            organization: await OrganizationService.getOrganization(req.userId, req.params.orgId)
        });
    } catch (error) {
        sendError(res, error);
    }
};

exports.updateOrganization = async (req, res) => {
    try {
        res.status(200).json({
            success: true,
            organization: await OrganizationService.updateOrganization(req.userId, req.params.orgId, req.body)
        });
    } catch (error) {
        sendError(res, error);
    }
};

exports.getOverview = async (req, res) => {
    try {
        res.status(200).json({
            success: true,
            overview: await OrganizationService.getOverview(req.userId, req.params.orgId)
        });
    } catch (error) {
        sendError(res, error);
    }
};

exports.listTeams = async (req, res) => {
    try {
        res.status(200).json({
            success: true,
            teams: await OrganizationService.listTeams(req.userId, req.params.orgId)
        });
    } catch (error) {
        sendError(res, error);
    }
};

exports.createTeam = async (req, res) => {
    try {
        res.status(201).json({
            success: true,
            team: await OrganizationService.createTeam(req.userId, req.params.orgId, req.body)
        });
    } catch (error) {
        sendError(res, error);
    }
};

exports.updateTeam = async (req, res) => {
    try {
        res.status(200).json({
            success: true,
            team: await OrganizationService.updateTeam(req.userId, req.params.orgId, req.params.teamId, req.body)
        });
    } catch (error) {
        sendError(res, error);
    }
};

exports.deleteTeam = async (req, res) => {
    try {
        res.status(200).json(await OrganizationService.deleteTeam(req.userId, req.params.orgId, req.params.teamId));
    } catch (error) {
        sendError(res, error);
    }
};

exports.listMembers = async (req, res) => {
    try {
        res.status(200).json({
            success: true,
            members: await OrganizationService.listMembers(req.userId, req.params.orgId)
        });
    } catch (error) {
        sendError(res, error);
    }
};

exports.addMember = async (req, res) => {
    try {
        res.status(201).json({
            success: true,
            member: await OrganizationService.addMember(req.userId, req.params.orgId, req.body)
        });
    } catch (error) {
        sendError(res, error);
    }
};

exports.updateMember = async (req, res) => {
    try {
        res.status(200).json({
            success: true,
            member: await OrganizationService.updateMember(req.userId, req.params.orgId, req.params.memberId, req.body)
        });
    } catch (error) {
        sendError(res, error);
    }
};

exports.suspendMember = async (req, res) => {
    try {
        res.status(200).json({
            success: true,
            member: await OrganizationService.suspendMember(req.userId, req.params.orgId, req.params.memberId, true)
        });
    } catch (error) {
        sendError(res, error);
    }
};

exports.reactivateMember = async (req, res) => {
    try {
        res.status(200).json({
            success: true,
            member: await OrganizationService.suspendMember(req.userId, req.params.orgId, req.params.memberId, false)
        });
    } catch (error) {
        sendError(res, error);
    }
};

exports.removeMember = async (req, res) => {
    try {
        res.status(200).json(await OrganizationService.removeMember(req.userId, req.params.orgId, req.params.memberId));
    } catch (error) {
        sendError(res, error);
    }
};

exports.setMemberTeams = async (req, res) => {
    try {
        res.status(200).json(await OrganizationService.setMemberTeams(req.userId, req.params.orgId, req.params.userId, req.body.teamIds || []));
    } catch (error) {
        sendError(res, error);
    }
};

exports.listTeamMembers = async (req, res) => {
    try {
        res.status(200).json({
            success: true,
            members: await OrganizationService.listTeamMembers(req.userId, req.params.orgId, req.params.teamId)
        });
    } catch (error) {
        sendError(res, error);
    }
};

exports.addTeamMember = async (req, res) => {
    try {
        res.status(201).json(await OrganizationService.addTeamMember(req.userId, req.params.orgId, req.params.teamId, req.body));
    } catch (error) {
        sendError(res, error);
    }
};

exports.removeTeamMember = async (req, res) => {
    try {
        res.status(200).json(await OrganizationService.removeTeamMember(req.userId, req.params.orgId, req.params.teamId, req.params.userId));
    } catch (error) {
        sendError(res, error);
    }
};

exports.listAudit = async (req, res) => {
    try {
        res.status(200).json({
            success: true,
            audit: await OrganizationService.listAudit(req.userId, req.params.orgId, req.query)
        });
    } catch (error) {
        sendError(res, error);
    }
};

exports.listShareTargets = async (req, res) => {
    try {
        res.status(200).json({
            success: true,
            targets: await OrganizationShareService.listShareTargets(req.userId, req.params.orgId)
        });
    } catch (error) {
        sendError(res, error);
    }
};

exports.listShares = async (req, res) => {
    try {
        res.status(200).json({
            success: true,
            ...(await OrganizationShareService.listOrganizationShares(req.userId, req.params.orgId, req.query))
        });
    } catch (error) {
        sendError(res, error);
    }
};

exports.simulatePolicy = async (req, res) => {
    try {
        res.status(200).json({
            success: true,
            simulation: await OrganizationShareService.simulatePolicy(req.userId, req.params.orgId, req.body)
        });
    } catch (error) {
        sendError(res, error);
    }
};

exports.createShare = async (req, res) => {
    try {
        res.status(201).json({
            success: true,
            share: await OrganizationShareService.createShare(req.userId, req.params.orgId, req.body)
        });
    } catch (error) {
        sendError(res, error);
    }
};

exports.updateShare = async (req, res) => {
    try {
        res.status(200).json({
            success: true,
            share: await OrganizationShareService.updateShare(req.userId, req.params.orgId, req.params.shareId, req.body)
        });
    } catch (error) {
        sendError(res, error);
    }
};

exports.revokeShare = async (req, res) => {
    try {
        res.status(200).json(await OrganizationShareService.revokeShare(req.userId, req.params.orgId, req.params.shareId));
    } catch (error) {
        sendError(res, error);
    }
};
