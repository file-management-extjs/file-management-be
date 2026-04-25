const mongoose = require('mongoose');

const Organization = require('../models/organizationModel');
const OrganizationMember = require('../models/organizationMemberModel');
const Team = require('../models/teamModel');
const TeamMember = require('../models/teamMemberModel');
const OrganizationAudit = require('../models/organizationAuditModel');
const User = require('../models/userModel');
const File = require('../models/fileModel');
const Folder = require('../models/folderModel');
const Share = require('../models/shareModel');
const ShareLink = require('../models/shareLinkModel');
const OrganizationPolicyService = require('./organizationPolicyService');
const WorkspaceService = require('./workspaceService');

function normalizeText(value) {
    return String(value || '').trim();
}

function normalizeEmail(value) {
    return normalizeText(value).toLowerCase();
}

function slugify(value) {
    return normalizeText(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || `org-${Date.now()}`;
}

function safeId(value) {
    return value && value.toString ? value.toString() : String(value || '');
}

function roleList(roles) {
    const allowed = ['owner', 'admin', 'teamAdmin', 'member'];
    const list = Array.isArray(roles) ? roles : [roles || 'member'];
    const unique = Array.from(new Set(list.filter(role => allowed.includes(role))));
    return unique.length ? unique : ['member'];
}

function normalizeMemberPayload(payload = {}) {
    return {
        roles: roleList(payload.roles || payload.role || 'member'),
        settings: payload.settings && typeof payload.settings === 'object' ? payload.settings : {}
    };
}

function formatUser(user) {
    if (!user) {
        return null;
    }

    return {
        id: safeId(user._id),
        username: user.username,
        email: user.email
    };
}

function getMemberPrincipalId(member) {
    return member && member.userId
        ? member.userId.toString()
        : `member:${safeId(member && member._id)}`;
}

function getUserIdentityFilter(userId, user) {
    const filter = [{ userId: userId.toString() }];

    if (user && user.email) {
        filter.push({ email: normalizeEmail(user.email) });
    }

    if (user && user.username) {
        filter.push({ email: normalizeEmail(user.username) });
    }

    return filter;
}

class OrganizationService {
    static async writeAudit(organizationId, actorUserId, action, entityType, entityId, metadata = {}) {
        if (!organizationId || !action || !entityType) {
            return null;
        }

        return OrganizationAudit.create({
            organizationId: organizationId.toString(),
            actorUserId: actorUserId ? actorUserId.toString() : null,
            action,
            entityType,
            entityId: entityId ? entityId.toString() : null,
            targetUserId: metadata.targetUserId ? metadata.targetUserId.toString() : null,
            metadata
        });
    }

    static async createOrganization(actorUserId, payload = {}) {
        const name = normalizeText(payload.name);
        if (!name) {
            throw OrganizationPolicyService.createError('Organization name is required.', 400, 'ORG_NAME_REQUIRED');
        }

        const baseSlug = slugify(payload.slug || name);
        let slug = baseSlug;
        let suffix = 2;

        while (await Organization.exists({ slug })) {
            slug = `${baseSlug}-${suffix}`;
            suffix += 1;
        }

        const organization = await Organization.create({
            name,
            slug,
            description: normalizeText(payload.description),
            ownerUserId: actorUserId.toString(),
            status: payload.status === 'suspended' ? 'suspended' : 'active',
            settings: OrganizationPolicyService.normalizeSettings(payload.settings)
        });

        await OrganizationMember.create({
            organizationId: safeId(organization._id),
            userId: actorUserId.toString(),
            roles: ['owner', 'admin', 'member'],
            status: 'active',
            joinedAt: new Date()
        });

        await WorkspaceService.ensureOrganizationWorkspace(organization);

        await this.writeAudit(organization._id, actorUserId, 'organization.created', 'organization', organization._id, {
            name: organization.name,
            slug: organization.slug
        });

        return this.getContext(actorUserId);
    }

    static async getContext(userId, selectedOrganizationId = null) {
        const user = await User.findById(userId).select('_id username email').lean();
        const identityFilter = getUserIdentityFilter(userId, user);

        const rawMemberships = await OrganizationMember.find({
            $or: identityFilter,
            status: { $in: ['active', 'invited', 'suspended'] }
        }).sort({ updatedAt: -1 }).lean();
        const membershipsById = rawMemberships.reduce((result, membership) => {
            result[safeId(membership._id)] = membership;
            return result;
        }, {});
        const memberships = Object.values(membershipsById);
        const organizationIds = Array.from(new Set(memberships.map(membership => membership.organizationId).filter(Boolean)));
        const organizations = organizationIds.length
            ? await Organization.find({ _id: { $in: organizationIds }, status: { $ne: 'archived' } }).lean()
            : [];
        const organizationsById = organizations.reduce((result, organization) => {
            result[safeId(organization._id)] = organization;
            return result;
        }, {});
        const activeMemberships = memberships.filter(membership => membership.status === 'active' && organizationsById[membership.organizationId]);
        const invitations = memberships.filter(membership => membership.status === 'invited' && organizationsById[membership.organizationId]);
        const suspendedMemberships = memberships.filter(membership => membership.status === 'suspended' && organizationsById[membership.organizationId]);

        if (!activeMemberships.length) {
            return {
                hasOrganization: false,
                hasPendingInvitations: invitations.length > 0,
                organization: null,
                membership: null,
                memberships: [],
                suspendedMemberships: suspendedMemberships.map(membership => this.serializeMembership(membership, {
                    organization: this.serializeOrganization(organizationsById[membership.organizationId])
                })),
                invitations: invitations.map(membership => this.serializeMembership(membership, {
                    organization: this.serializeOrganization(organizationsById[membership.organizationId])
                })),
                teams: [],
                capabilities: {
                    canCreateOrganization: true,
                    canManageOrganization: false,
                    canManageTeams: false,
                    canManageMembers: false,
                    canManageSharing: false
                }
            };
        }

        const selectedMembership = selectedOrganizationId
            ? activeMemberships.find(member => member.organizationId === selectedOrganizationId.toString())
            : null;
        const membership = selectedMembership ||
            activeMemberships.find(member => OrganizationPolicyService.hasOrgAdminRole(member)) ||
            activeMemberships[0];
        const [organization, teamMemberships] = await Promise.all([
            Organization.findById(membership.organizationId).lean(),
            TeamMember.find({
                organizationId: membership.organizationId,
                userId: userId.toString(),
                status: 'active'
            }).lean()
        ]);

        const teamIds = teamMemberships.map(teamMembership => teamMembership.teamId);
        const teams = teamIds.length
            ? await Team.find({ _id: { $in: teamIds }, status: 'active' }).lean()
            : [];
        const canManageOrganization = OrganizationPolicyService.hasOrgAdminRole(membership);
        const teamAdminIds = teamMemberships
            .filter(teamMembership => teamMembership.role === 'admin')
            .map(teamMembership => teamMembership.teamId);

        return {
            hasOrganization: !!organization,
            hasPendingInvitations: invitations.length > 0,
            organization: organization ? this.serializeOrganization(organization) : null,
            membership: this.serializeMembership(membership),
            memberships: activeMemberships.map(activeMembership => this.serializeMembership(activeMembership, {
                organization: this.serializeOrganization(organizationsById[activeMembership.organizationId])
            })),
            suspendedMemberships: suspendedMemberships.map(suspendedMembership => this.serializeMembership(suspendedMembership, {
                organization: this.serializeOrganization(organizationsById[suspendedMembership.organizationId])
            })),
            invitations: invitations.map(invitation => this.serializeMembership(invitation, {
                organization: this.serializeOrganization(organizationsById[invitation.organizationId])
            })),
            teams: teams.map(team => this.serializeTeam(team, { membershipRole: teamAdminIds.includes(safeId(team._id)) ? 'admin' : 'member' })),
            capabilities: {
                canCreateOrganization: true,
                canManageOrganization,
                canManageTeams: canManageOrganization || teamAdminIds.length > 0,
                canManageMembers: canManageOrganization || teamAdminIds.length > 0,
                canManageSharing: canManageOrganization,
                teamAdminTeamIds: teamAdminIds
            }
        };
    }

    static async acceptInvitation(userId, membershipId) {
        const user = await User.findById(userId).select('_id username email').lean();
        if (!user) {
            throw OrganizationPolicyService.createError('User not found.', 404, 'USER_NOT_FOUND');
        }

        const identityFilter = getUserIdentityFilter(userId, user);

        const invitation = await OrganizationMember.findOne({
            _id: membershipId,
            status: 'invited',
            $or: identityFilter
        });

        if (!invitation) {
            throw OrganizationPolicyService.createError('Invitation not found.', 404, 'INVITATION_NOT_FOUND');
        }

        const previousPrincipalId = getMemberPrincipalId(invitation);
        invitation.userId = userId.toString();
        invitation.email = user.email || invitation.email;
        invitation.displayName = invitation.displayName || user.username || user.email;
        invitation.status = 'active';
        invitation.joinedAt = new Date();
        invitation.removedAt = null;
        await invitation.save();

        if (previousPrincipalId !== userId.toString()) {
            await TeamMember.updateMany(
                {
                    organizationId: invitation.organizationId,
                    userId: previousPrincipalId
                },
                {
                    $set: {
                        userId: userId.toString()
                    }
                }
            );
        }

        await this.writeAudit(invitation.organizationId, userId, 'member.invitation.accepted', 'member', invitation._id, {
            targetUserId: userId
        });
        await WorkspaceService.ensureOrganizationWorkspace(invitation.organizationId);

        return this.getContext(userId);
    }

    static async declineInvitation(userId, membershipId) {
        const user = await User.findById(userId).select('_id username email').lean();
        if (!user) {
            throw OrganizationPolicyService.createError('User not found.', 404, 'USER_NOT_FOUND');
        }

        const identityFilter = getUserIdentityFilter(userId, user);

        const invitation = await OrganizationMember.findOne({
            _id: membershipId,
            status: 'invited',
            $or: identityFilter
        });

        if (!invitation) {
            throw OrganizationPolicyService.createError('Invitation not found.', 404, 'INVITATION_NOT_FOUND');
        }

        const previousPrincipalId = getMemberPrincipalId(invitation);
        invitation.status = 'removed';
        invitation.removedAt = new Date();
        await invitation.save();

        await TeamMember.updateMany(
            {
                organizationId: invitation.organizationId,
                userId: previousPrincipalId
            },
            {
                $set: {
                    status: 'removed'
                }
            }
        );

        await this.writeAudit(invitation.organizationId, userId, 'member.invitation.declined', 'member', invitation._id, {
            targetUserId: userId,
            email: invitation.email
        });

        return this.getContext(userId);
    }

    static serializeOrganization(organization) {
        return {
            id: safeId(organization._id),
            name: organization.name,
            slug: organization.slug,
            description: organization.description || '',
            status: organization.status,
            ownerUserId: organization.ownerUserId,
            settings: OrganizationPolicyService.normalizeSettings(organization.settings),
            createdAt: organization.createdAt,
            updatedAt: organization.updatedAt
        };
    }

    static serializeMembership(member, extra = {}) {
        return {
            id: safeId(member._id),
            organizationId: member.organizationId,
            userId: member.userId,
            email: member.email || '',
            displayName: member.displayName || '',
            status: member.status,
            roles: roleList(member.roles),
            settings: member.settings || {},
            invitedBy: member.invitedBy || null,
            invitedAt: member.invitedAt || null,
            joinedAt: member.joinedAt || null,
            createdAt: member.createdAt,
            updatedAt: member.updatedAt,
            ...extra
        };
    }

    static serializeTeam(team, extra = {}) {
        return {
            id: safeId(team._id),
            organizationId: team.organizationId,
            name: team.name,
            description: team.description || '',
            status: team.status,
            adminUserIds: team.adminUserIds || [],
            settings: team.settings || {},
            createdBy: team.createdBy || null,
            createdAt: team.createdAt,
            updatedAt: team.updatedAt,
            ...extra
        };
    }

    static async getOrganization(actorUserId, organizationId) {
        await OrganizationPolicyService.assertReadableMember(actorUserId, organizationId);
        const organization = await Organization.findById(organizationId).lean();
        return this.serializeOrganization(organization);
    }

    static async updateOrganization(actorUserId, organizationId, payload = {}) {
        await OrganizationPolicyService.assertManageableOrgAdmin(actorUserId, organizationId);
        const organization = await Organization.findById(organizationId);
        if (!organization) {
            throw OrganizationPolicyService.createError('Organization not found.', 404, 'ORG_NOT_FOUND');
        }

        const name = normalizeText(payload.name);
        if (name) {
            organization.name = name;
        }

        if (payload.description !== undefined) {
            organization.description = normalizeText(payload.description);
        }

        if (['active', 'suspended'].includes(payload.status)) {
            organization.status = payload.status;
        }

        if (payload.settings && typeof payload.settings === 'object') {
            organization.settings = OrganizationPolicyService.normalizeSettings(payload.settings);
            organization.markModified('settings');
        }

        await organization.save();
        await WorkspaceService.ensureOrganizationWorkspace(organization);
        await this.writeAudit(organizationId, actorUserId, 'organization.updated', 'organization', organizationId, {
            name: organization.name,
            status: organization.status
        });

        return this.serializeOrganization(organization.toObject());
    }

    static async getOverview(actorUserId, organizationId) {
        await OrganizationPolicyService.assertManageableOrgAdmin(actorUserId, organizationId);
        const [organization, members, teams] = await Promise.all([
            Organization.findById(organizationId).lean(),
            OrganizationMember.find({ organizationId: organizationId.toString(), status: { $ne: 'removed' } }).lean(),
            Team.find({ organizationId: organizationId.toString(), status: { $ne: 'deleted' } }).lean()
        ]);
        const workspace = organization ? await WorkspaceService.ensureOrganizationWorkspace(organization) : null;
        const workspaceQuery = workspace ? { workspaceId: safeId(workspace._id) } : { organizationId: organizationId.toString() };

        const userIds = members.filter(member => member.userId).map(member => member.userId);
        const [fileAgg, folderAgg, shareCount, externalShareCount, publicLinkCount] = await Promise.all([
            File.aggregate([
                { $match: { ...workspaceQuery, deleted: false, scanStatus: { $in: [null, 'clean'] } } },
                { $group: { _id: null, totalBytes: { $sum: '$size' }, totalFiles: { $sum: 1 } } }
            ]),
            Folder.aggregate([
                { $match: { ...workspaceQuery, deleted: false, parent_id: null } },
                { $group: { _id: null, totalFolderBytes: { $sum: '$size' } } }
            ]),
            Share.countDocuments({ organizationId: organizationId.toString(), revoked: false }),
            Share.countDocuments({ organizationId: organizationId.toString(), revoked: false, isExternalTarget: true }),
            ShareLink.countDocuments({ organizationId: organizationId.toString(), revoked: false })
        ]);

        const activeMembers = members.filter(member => member.status === 'active').length;
        const suspendedMembers = members.filter(member => member.status === 'suspended').length;
        const pendingInvites = members.filter(member => member.status === 'invited').length;
        const totalBytes = (fileAgg[0] && fileAgg[0].totalBytes) || 0;

        return {
            organization: this.serializeOrganization(organization),
            counts: {
                teams: teams.filter(team => team.status === 'active').length,
                members: members.length,
                activeMembers,
                suspendedMembers,
                pendingInvites,
                sharedItems: shareCount + publicLinkCount,
                externalShares: externalShareCount + publicLinkCount
            },
            storage: {
                usedBytes: totalBytes,
                rootFolderBytes: (folderAgg[0] && folderAgg[0].totalFolderBytes) || 0,
                fileCount: (fileAgg[0] && fileAgg[0].totalFiles) || 0
            }
        };
    }

    static async listTeams(actorUserId, organizationId) {
        const context = await OrganizationPolicyService.assertReadableMember(actorUserId, organizationId);
        const query = { organizationId: organizationId.toString(), status: { $ne: 'deleted' } };

        if (!OrganizationPolicyService.hasOrgAdminRole(context.membership)) {
            const teamMemberships = await OrganizationPolicyService.getActiveTeamMemberships(actorUserId, organizationId);
            const adminTeamIds = teamMemberships
                .filter(teamMembership => teamMembership.role === 'admin')
                .map(teamMembership => teamMembership.teamId);
            query._id = { $in: adminTeamIds };
        }

        const teams = await Team.find(query).sort({ name: 1 }).lean();
        const memberCounts = await TeamMember.aggregate([
            { $match: { organizationId: organizationId.toString(), status: 'active' } },
            { $group: { _id: '$teamId', count: { $sum: 1 } } }
        ]);
        const countsByTeam = memberCounts.reduce((result, row) => {
            result[row._id] = row.count;
            return result;
        }, {});

        return teams.map(team => this.serializeTeam(team, {
            memberCount: countsByTeam[safeId(team._id)] || 0
        }));
    }

    static async createTeam(actorUserId, organizationId, payload = {}) {
        await OrganizationPolicyService.assertOrgAdmin(actorUserId, organizationId);
        const name = normalizeText(payload.name);
        if (!name) {
            throw OrganizationPolicyService.createError('Team name is required.', 400, 'TEAM_NAME_REQUIRED');
        }

        const team = await Team.create({
            organizationId: organizationId.toString(),
            name,
            description: normalizeText(payload.description),
            status: payload.status === 'inactive' ? 'inactive' : 'active',
            adminUserIds: Array.isArray(payload.adminUserIds) ? payload.adminUserIds.map(String) : [],
            settings: payload.settings && typeof payload.settings === 'object' ? payload.settings : {},
            createdBy: actorUserId.toString()
        });

        await this.writeAudit(organizationId, actorUserId, 'team.created', 'team', team._id, {
            name: team.name
        });

        return this.serializeTeam(team.toObject());
    }

    static async updateTeam(actorUserId, organizationId, teamId, payload = {}) {
        await OrganizationPolicyService.assertTeamAdmin(actorUserId, organizationId, teamId);
        const team = await Team.findOne({ _id: teamId, organizationId: organizationId.toString(), status: { $ne: 'deleted' } });
        if (!team) {
            throw OrganizationPolicyService.createError('Team not found.', 404, 'TEAM_NOT_FOUND');
        }

        const name = normalizeText(payload.name);
        if (name) {
            team.name = name;
        }

        if (payload.description !== undefined) {
            team.description = normalizeText(payload.description);
        }

        if (['active', 'inactive'].includes(payload.status)) {
            team.status = payload.status;
        }

        if (Array.isArray(payload.adminUserIds)) {
            team.adminUserIds = payload.adminUserIds.map(String);
        }

        if (payload.settings && typeof payload.settings === 'object') {
            team.settings = payload.settings;
            team.markModified('settings');
        }

        await team.save();
        await this.writeAudit(organizationId, actorUserId, 'team.updated', 'team', teamId, {
            name: team.name,
            status: team.status
        });

        return this.serializeTeam(team.toObject());
    }

    static async deleteTeam(actorUserId, organizationId, teamId) {
        await OrganizationPolicyService.assertOrgAdmin(actorUserId, organizationId);
        const team = await Team.findOne({ _id: teamId, organizationId: organizationId.toString(), status: { $ne: 'deleted' } });
        if (!team) {
            throw OrganizationPolicyService.createError('Team not found.', 404, 'TEAM_NOT_FOUND');
        }

        team.status = 'deleted';
        await team.save();
        await TeamMember.updateMany({ teamId: teamId.toString() }, { $set: { status: 'removed' } });
        await this.writeAudit(organizationId, actorUserId, 'team.deleted', 'team', teamId, {
            name: team.name
        });

        return { success: true };
    }

    static async listMembers(actorUserId, organizationId) {
        const context = await OrganizationPolicyService.assertReadableMember(actorUserId, organizationId);
        const orgAdmin = OrganizationPolicyService.hasOrgAdminRole(context.membership);
        let members = await OrganizationMember.find({
            organizationId: organizationId.toString(),
            status: { $ne: 'removed' }
        }).sort({ updatedAt: -1 }).lean();

        if (!orgAdmin) {
            const teamMemberships = await OrganizationPolicyService.getActiveTeamMemberships(actorUserId, organizationId);
            const adminTeamIds = teamMemberships
                .filter(teamMembership => teamMembership.role === 'admin')
                .map(teamMembership => teamMembership.teamId);
            const scopedTeamMembers = adminTeamIds.length
                ? await TeamMember.find({ teamId: { $in: adminTeamIds }, status: 'active' }).lean()
                : [];
            const scopedUserIds = new Set(scopedTeamMembers.map(teamMember => teamMember.userId));
            members = members.filter(member => member.userId && scopedUserIds.has(member.userId));
        }

        return this.enrichMembers(members, organizationId);
    }

    static async enrichMembers(members, organizationId) {
        const userIds = members.filter(member => member.userId).map(member => member.userId);
        const [users, teamMemberships, teams] = await Promise.all([
            userIds.length ? User.find({ _id: { $in: userIds } }).select('_id username email').lean() : [],
            TeamMember.find({ organizationId: organizationId.toString(), status: 'active' }).lean(),
            Team.find({ organizationId: organizationId.toString(), status: 'active' }).select('_id name').lean()
        ]);
        const usersById = users.reduce((result, user) => {
            result[safeId(user._id)] = user;
            return result;
        }, {});
        const teamsById = teams.reduce((result, team) => {
            result[safeId(team._id)] = team;
            return result;
        }, {});
        const membershipsByPrincipal = teamMemberships.reduce((result, teamMember) => {
            const principalId = teamMember.userId;

            if (!result[principalId]) {
                result[principalId] = [];
            }

            result[principalId].push({
                id: teamMember.teamId,
                name: teamsById[teamMember.teamId] ? teamsById[teamMember.teamId].name : 'Unknown team',
                role: teamMember.role
            });
            return result;
        }, {});

        return members.map(member => {
            const user = usersById[member.userId];
            const principalId = getMemberPrincipalId(member);
            const memberTeams = membershipsByPrincipal[principalId] || [];

            return this.serializeMembership(member, {
                user: formatUser(user),
                username: user ? user.username : '',
                email: user ? user.email : member.email,
                displayName: member.displayName || (user ? user.username : member.email),
                teams: memberTeams,
                teamNames: memberTeams.map(team => team.name).join(', ')
            });
        });
    }

    static async addMember(actorUserId, organizationId, payload = {}) {
        await OrganizationPolicyService.assertOrgAdmin(actorUserId, organizationId);
        const identifier = normalizeText(payload.identifier || payload.email || payload.username);
        if (!identifier) {
            throw OrganizationPolicyService.createError('Member username or email is required.', 400, 'MEMBER_IDENTIFIER_REQUIRED');
        }

        const normalized = normalizeEmail(identifier);
        const user = await User.findOne({
            $or: [
                { username: identifier },
                { email: normalized }
            ]
        }).select('_id username email');
        const memberPayload = normalizeMemberPayload(payload);
        const existingMember = user
            ? await OrganizationMember.findOne({
                organizationId: organizationId.toString(),
                $or: [
                    { userId: safeId(user._id) },
                    {
                        userId: null,
                        email: {
                            $in: [
                                normalizeEmail(user.email),
                                normalizeEmail(user.username),
                                normalized
                            ].filter(Boolean)
                        }
                    }
                ]
            }).lean()
            : await OrganizationMember.findOne({
                organizationId: organizationId.toString(),
                email: normalized,
                userId: null
            }).lean();
        const existingQuery = existingMember
            ? { _id: existingMember._id }
            : (user
                ? { organizationId: organizationId.toString(), userId: safeId(user._id) }
                : { organizationId: organizationId.toString(), email: normalized, userId: null });
        const nextStatus = existingMember && existingMember.status === 'active'
            ? 'active'
            : 'invited';
        const update = {
            organizationId: organizationId.toString(),
            userId: user ? safeId(user._id) : null,
            email: user ? user.email : normalized,
            displayName: normalizeText(payload.displayName) || (user ? user.username : identifier),
            status: nextStatus,
            roles: memberPayload.roles,
            settings: memberPayload.settings,
            invitedBy: actorUserId.toString(),
            invitedAt: new Date(),
            joinedAt: nextStatus === 'active' ? (existingMember && existingMember.joinedAt) || new Date() : null,
            removedAt: null
        };

        const member = await OrganizationMember.findOneAndUpdate(existingQuery, update, {
            upsert: true,
            new: true,
            setDefaultsOnInsert: true
        });

        if (Array.isArray(payload.teamIds) && payload.teamIds.length) {
            await this.setMemberTeams(actorUserId, organizationId, user ? safeId(user._id) : safeId(member._id), payload.teamIds);
        }

        await this.writeAudit(organizationId, actorUserId, nextStatus === 'active' ? 'member.updated' : 'member.invited', 'member', member._id, {
            targetUserId: user ? safeId(user._id) : null,
            email: update.email,
            roles: update.roles
        });

        return (await this.enrichMembers([member.toObject()], organizationId))[0];
    }

    static async updateMember(actorUserId, organizationId, memberId, payload = {}) {
        await OrganizationPolicyService.assertOrgAdmin(actorUserId, organizationId);
        const member = await OrganizationMember.findOne({
            _id: memberId,
            organizationId: organizationId.toString(),
            status: { $ne: 'removed' }
        });

        if (!member) {
            throw OrganizationPolicyService.createError('Member not found.', 404, 'MEMBER_NOT_FOUND');
        }

        const roles = roleList(payload.roles || payload.role || member.roles);
        if (member.roles.includes('owner') && !roles.includes('owner')) {
            throw OrganizationPolicyService.createError('The organization owner role cannot be removed from this screen.', 400, 'OWNER_ROLE_PROTECTED');
        }

        member.roles = roles;

        if (payload.status && ['active', 'suspended', 'invited'].includes(payload.status)) {
            member.status = !member.userId && payload.status === 'active' ? 'invited' : payload.status;
        }

        if (payload.settings && typeof payload.settings === 'object') {
            member.settings = payload.settings;
            member.markModified('settings');
        }

        if (payload.displayName !== undefined) {
            member.displayName = normalizeText(payload.displayName);
        }

        await member.save();

        if (Array.isArray(payload.teamIds)) {
            await this.setMemberTeams(actorUserId, organizationId, safeId(member._id), payload.teamIds);
        }

        await this.writeAudit(organizationId, actorUserId, 'member.updated', 'member', member._id, {
            targetUserId: member.userId,
            roles: member.roles,
            status: member.status
        });

        return (await this.enrichMembers([member.toObject()], organizationId))[0];
    }

    static async setMemberTeams(actorUserId, organizationId, memberRef, teamIds = []) {
        await OrganizationPolicyService.assertOrgAdmin(actorUserId, organizationId);
        const member = await OrganizationMember.findOne({
            organizationId: organizationId.toString(),
            $or: [
                { _id: memberRef.toString() },
                { userId: memberRef.toString() }
            ],
            status: { $ne: 'removed' }
        }).lean();

        if (!member) {
            throw OrganizationPolicyService.createError('Organization member not found.', 404, 'MEMBER_NOT_FOUND');
        }

        const principalId = getMemberPrincipalId(member);
        const validTeams = await Team.find({
            _id: { $in: teamIds.map(String).filter(id => mongoose.Types.ObjectId.isValid(id)) },
            organizationId: organizationId.toString(),
            status: 'active'
        }).lean();
        const validTeamIds = validTeams.map(team => safeId(team._id));

        await TeamMember.updateMany(
            {
                organizationId: organizationId.toString(),
                userId: principalId,
                teamId: { $nin: validTeamIds }
            },
            { $set: { status: 'removed' } }
        );

        for (const teamId of validTeamIds) {
            await TeamMember.findOneAndUpdate(
                {
                    organizationId: organizationId.toString(),
                    teamId,
                    userId: principalId
                },
                {
                    organizationId: organizationId.toString(),
                    teamId,
                    userId: principalId,
                    role: 'member',
                    status: 'active'
                },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );
        }

        await this.writeAudit(organizationId, actorUserId, 'member.teams.updated', 'member', member._id, {
            targetUserId: member.userId || null,
            principalId,
            teamIds: validTeamIds
        });

        return { success: true, teamIds: validTeamIds };
    }

    static async addTeamMember(actorUserId, organizationId, teamId, payload = {}) {
        await OrganizationPolicyService.assertTeamAdmin(actorUserId, organizationId, teamId);
        const userId = normalizeText(payload.userId);
        if (!userId) {
            throw OrganizationPolicyService.createError('User id is required.', 400, 'USER_ID_REQUIRED');
        }

        const member = await OrganizationMember.findOne({
            organizationId: organizationId.toString(),
            userId,
            status: 'active'
        }).lean();
        const team = await Team.findOne({ _id: teamId, organizationId: organizationId.toString(), status: 'active' }).lean();

        if (!member || !team) {
            throw OrganizationPolicyService.createError('Member or team not found.', 404, 'TEAM_MEMBER_TARGET_NOT_FOUND');
        }

        const role = payload.role === 'admin' ? 'admin' : 'member';
        await TeamMember.findOneAndUpdate(
            { organizationId: organizationId.toString(), teamId: teamId.toString(), userId },
            { organizationId: organizationId.toString(), teamId: teamId.toString(), userId, role, status: 'active' },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        await this.writeAudit(organizationId, actorUserId, 'team.member.added', 'team', teamId, {
            targetUserId: userId,
            role
        });

        return { success: true };
    }

    static async removeTeamMember(actorUserId, organizationId, teamId, userId) {
        await OrganizationPolicyService.assertTeamAdmin(actorUserId, organizationId, teamId);
        await TeamMember.updateOne(
            {
                organizationId: organizationId.toString(),
                teamId: teamId.toString(),
                userId: userId.toString()
            },
            { $set: { status: 'removed' } }
        );

        await this.writeAudit(organizationId, actorUserId, 'team.member.removed', 'team', teamId, {
            targetUserId: userId
        });

        return { success: true };
    }

    static async suspendMember(actorUserId, organizationId, memberId, suspended) {
        await OrganizationPolicyService.assertOrgAdmin(actorUserId, organizationId);
        const member = await OrganizationMember.findOne({
            _id: memberId,
            organizationId: organizationId.toString(),
            status: { $ne: 'removed' }
        });

        if (!member) {
            throw OrganizationPolicyService.createError('Member not found.', 404, 'MEMBER_NOT_FOUND');
        }

        if (member.roles.includes('owner')) {
            throw OrganizationPolicyService.createError('Organization owner cannot be suspended.', 400, 'OWNER_PROTECTED');
        }

        member.status = suspended ? 'suspended' : 'active';
        await member.save();
        await this.writeAudit(organizationId, actorUserId, suspended ? 'member.suspended' : 'member.reactivated', 'member', member._id, {
            targetUserId: member.userId
        });

        return (await this.enrichMembers([member.toObject()], organizationId))[0];
    }

    static async removeMember(actorUserId, organizationId, memberId) {
        await OrganizationPolicyService.assertOrgAdmin(actorUserId, organizationId);
        const member = await OrganizationMember.findOne({
            _id: memberId,
            organizationId: organizationId.toString(),
            status: { $ne: 'removed' }
        });

        if (!member) {
            throw OrganizationPolicyService.createError('Member not found.', 404, 'MEMBER_NOT_FOUND');
        }

        if (member.roles.includes('owner')) {
            throw OrganizationPolicyService.createError('Organization owner cannot be removed.', 400, 'OWNER_PROTECTED');
        }

        member.status = 'removed';
        member.removedAt = new Date();
        await member.save();

        if (member.userId) {
            await TeamMember.updateMany(
                { organizationId: organizationId.toString(), userId: member.userId },
                { $set: { status: 'removed' } }
            );
        }

        await this.writeAudit(organizationId, actorUserId, 'member.removed', 'member', member._id, {
            targetUserId: member.userId,
            email: member.email
        });

        return { success: true };
    }

    static async listTeamMembers(actorUserId, organizationId, teamId) {
        await OrganizationPolicyService.assertReadableTeamAdmin(actorUserId, organizationId, teamId);
        const teamMembers = await TeamMember.find({
            organizationId: organizationId.toString(),
            teamId: teamId.toString(),
            status: 'active'
        }).lean();
        const userIds = teamMembers
            .map(member => member.userId)
            .filter(userId => !String(userId).startsWith('member:'));
        const memberIds = teamMembers
            .map(member => String(member.userId || ''))
            .filter(userId => userId.startsWith('member:'))
            .map(userId => userId.replace('member:', ''))
            .filter(Boolean);
        const members = await OrganizationMember.find({
            organizationId: organizationId.toString(),
            $or: [
                { userId: { $in: userIds } },
                { _id: { $in: memberIds } }
            ],
            status: { $ne: 'removed' }
        }).lean();

        return this.enrichMembers(members, organizationId);
    }

    static async listAudit(actorUserId, organizationId, options = {}) {
        await OrganizationPolicyService.assertManageableOrgAdmin(actorUserId, organizationId);
        const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 300);
        const rows = await OrganizationAudit.find({ organizationId: organizationId.toString() })
            .sort({ createdAt: -1 })
            .limit(limit)
            .lean();
        const actorIds = Array.from(new Set(rows.map(row => row.actorUserId).filter(Boolean)));
        const users = actorIds.length
            ? await User.find({ _id: { $in: actorIds } }).select('_id username email').lean()
            : [];
        const usersById = users.reduce((result, user) => {
            result[safeId(user._id)] = user;
            return result;
        }, {});

        return rows.map(row => ({
            id: safeId(row._id),
            organizationId: row.organizationId,
            actorUserId: row.actorUserId,
            actor: formatUser(usersById[row.actorUserId]),
            action: row.action,
            entityType: row.entityType,
            entityId: row.entityId,
            targetUserId: row.targetUserId,
            metadata: row.metadata || {},
            createdAt: row.createdAt
        }));
    }
}

module.exports = OrganizationService;
