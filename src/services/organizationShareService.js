const File = require('../models/fileModel');
const Folder = require('../models/folderModel');
const Share = require('../models/shareModel');
const ShareLink = require('../models/shareLinkModel');
const User = require('../models/userModel');
const OrganizationMember = require('../models/organizationMemberModel');
const Team = require('../models/teamModel');
const TeamMember = require('../models/teamMemberModel');
const OrganizationPolicyService = require('./organizationPolicyService');
const OrganizationService = require('./organizationService');
const ActivityEventService = require('./activityEventService');

function safeId(value) {
    return value && value.toString ? value.toString() : String(value || '');
}

function normalizeText(value) {
    return String(value || '').trim();
}

function normalizeEmail(value) {
    return normalizeText(value).toLowerCase();
}

function activeDateClause() {
    return {
        $or: [
            { expiresAt: null },
            { expiresAt: { $gt: new Date() } }
        ]
    };
}

function shareAllowsPermission(share, permission) {
    if (!share || share.revoked || isApprovalBlockingShare(share)) {
        return false;
    }

    const permissions = Array.isArray(share.permissions) && share.permissions.length
        ? share.permissions
        : [share.permission || 'view'];

    if (permissions.includes('manage')) {
        return true;
    }

    if (permission === 'view') {
        return permissions.some(value => ['view', 'download', 'upload', 'edit', 'reshare'].includes(value));
    }

    if (permission === 'download') {
        if (isDownloadLimitReached(share)) {
            return false;
        }

        return permissions.includes('download') || permissions.includes('edit');
    }

    return permissions.includes(permission);
}

function scoreShare(share) {
    const permissions = Array.isArray(share.permissions) && share.permissions.length
        ? share.permissions
        : [share.permission || 'view'];
    const weights = {
        view: 1,
        download: 2,
        upload: 3,
        edit: 4,
        reshare: 5,
        manage: 6
    };

    return permissions.reduce((max, permission) => Math.max(max, weights[permission] || 0), 0);
}

function normalizePermissionPayload(permission, permissions, fallbackPermission) {
    const requested = Array.isArray(permissions) && permissions.length
        ? permissions
        : [permission || fallbackPermission || 'download'];
    const normalized = OrganizationPolicyService.normalizePermissions(requested, ['view']);

    return {
        permission: normalized.includes('download') ? 'download' : normalized[0],
        permissions: normalized
    };
}

function getSharePermissions(share) {
    return Array.isArray(share.permissions) && share.permissions.length
        ? share.permissions
        : [share.permission || 'view'];
}

function getDownloadCount(entity) {
    return Math.max(0, Number(entity && entity.downloadCount) || 0);
}

function getEffectiveMaxDownloads(entity, policy = null) {
    const policyLimit = policy ? OrganizationPolicyService.getPolicyMaxDownloads(policy) : null;
    const entityLimit = OrganizationPolicyService.normalizeMaxDownloads(
        entity && entity.effectiveMaxDownloads !== undefined ? entity.effectiveMaxDownloads : entity && entity.maxDownloads
    );

    return policyLimit !== null ? policyLimit : entityLimit;
}

function isDownloadLimitReached(entity, policy = null) {
    const maxDownloads = getEffectiveMaxDownloads(entity, policy);
    return maxDownloads !== null && getDownloadCount(entity) >= maxDownloads;
}

function isExternalShareTarget(share) {
    const targetType = share && (share.targetType || 'member');
    return !!share && (share.isExternalTarget === true || targetType === 'external');
}

function isApprovalBlockingShare(share, policy = null) {
    if (!isExternalShareTarget(share)) {
        return false;
    }

    const approvalStatus = share.approvalStatus || 'not_required';
    if (approvalStatus === 'pending' || approvalStatus === 'rejected') {
        return true;
    }

    return !!policy &&
        OrganizationPolicyService.normalizeSharingPolicy(policy).requireExternalApproval === true &&
        approvalStatus !== 'approved';
}

function canDownloadFromPermissions(permissions) {
    return permissions.includes('manage') || permissions.includes('download') || permissions.includes('edit');
}

function applyCurrentPolicyToShare(share, policy) {
    const normalizedPolicy = OrganizationPolicyService.normalizeSharingPolicy(policy);
    const targetType = share.targetType || 'member';
    const external = isExternalShareTarget(share);

    if (external && normalizedPolicy.externalSharingAllowed === false) {
        return null;
    }

    if (!external && targetType === 'member' && normalizedPolicy.memberSharingAllowed === false) {
        return null;
    }

    if (targetType === 'team' && normalizedPolicy.teamSharingAllowed === false) {
        return null;
    }

    if (targetType === 'organization' && normalizedPolicy.organizationSharingAllowed === false) {
        return null;
    }

    if (external && normalizedPolicy.requireExternalExpiration && !share.expiresAt) {
        return null;
    }

    if (isApprovalBlockingShare(share, normalizedPolicy)) {
        return null;
    }

    const permissions = getSharePermissions(share)
        .filter(permission => normalizedPolicy.allowedPermissions.includes(permission));

    if (!permissions.length) {
        return null;
    }

    return {
        ...share,
        permissions,
        permission: permissions.includes('download') ? 'download' : permissions[0],
        effectiveMaxDownloads: OrganizationPolicyService.getPolicyMaxDownloads(normalizedPolicy),
        downloadLimitReached: isDownloadLimitReached(share, normalizedPolicy)
    };
}

function addReason(reasons, reason, reasonCounts) {
    reasons.push(reason);
    reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
}

function evaluateShareAgainstPolicy(share, policy, reasonCounts = {}) {
    const normalizedPolicy = OrganizationPolicyService.normalizeSharingPolicy(policy);
    const targetType = share.targetType || 'member';
    const external = isExternalShareTarget(share);
    const reasons = [];

    if (external && normalizedPolicy.externalSharingAllowed === false) {
        addReason(reasons, 'external_sharing_blocked', reasonCounts);
    }

    if (!external && targetType === 'member' && normalizedPolicy.memberSharingAllowed === false) {
        addReason(reasons, 'member_sharing_blocked', reasonCounts);
    }

    if (targetType === 'team' && normalizedPolicy.teamSharingAllowed === false) {
        addReason(reasons, 'team_sharing_blocked', reasonCounts);
    }

    if (targetType === 'organization' && normalizedPolicy.organizationSharingAllowed === false) {
        addReason(reasons, 'organization_sharing_blocked', reasonCounts);
    }

    if (external && normalizedPolicy.requireExternalExpiration && !share.expiresAt) {
        addReason(reasons, 'external_expiration_required', reasonCounts);
    }

    if (isApprovalBlockingShare(share, normalizedPolicy)) {
        addReason(reasons, 'external_approval_required', reasonCounts);
    }

    const permissions = getSharePermissions(share);
    const allowedPermissions = permissions.filter(permission => normalizedPolicy.allowedPermissions.includes(permission));
    if (!allowedPermissions.length) {
        addReason(reasons, 'permission_blocked', reasonCounts);
    }

    if (canDownloadFromPermissions(allowedPermissions.length ? allowedPermissions : permissions) &&
        isDownloadLimitReached(share, normalizedPolicy)) {
        addReason(reasons, 'download_limit_reached', reasonCounts);
    }

    return reasons;
}

function evaluatePublicLinkAgainstPolicy(link, policy, reasonCounts = {}) {
    const normalizedPolicy = OrganizationPolicyService.normalizeSharingPolicy(policy);
    const reasons = [];

    if (normalizedPolicy.publicLinkSharingAllowed === false) {
        addReason(reasons, 'public_link_sharing_blocked', reasonCounts);
    }

    if (normalizedPolicy.externalSharingAllowed === false) {
        addReason(reasons, 'external_sharing_blocked', reasonCounts);
    }

    if (normalizedPolicy.requireExternalApproval) {
        addReason(reasons, 'external_approval_required', reasonCounts);
    }

    if (normalizedPolicy.requireExternalExpiration && !link.expiresAt) {
        addReason(reasons, 'external_expiration_required', reasonCounts);
    }

    if (!normalizedPolicy.allowedPermissions.includes(link.permission)) {
        addReason(reasons, 'permission_blocked', reasonCounts);
    }

    if (link.permission === 'download' && isDownloadLimitReached(link, normalizedPolicy)) {
        addReason(reasons, 'download_limit_reached', reasonCounts);
    }

    return reasons;
}

async function getItemByType(itemId, itemType) {
    const Model = itemType === 'folder' ? Folder : File;
    return Model.findOne({ _id: itemId, deleted: false });
}

class OrganizationShareService {
    static shareAllowsPermission(share, permission) {
        return shareAllowsPermission(share, permission);
    }

    static isDownloadLimitReached(entity, policy = null) {
        return isDownloadLimitReached(entity, policy);
    }

    static async recordDownloadAccess(share) {
        if (!share || !share._id) {
            return null;
        }

        const maxDownloads = getEffectiveMaxDownloads(share);
        const filter = {
            _id: share._id,
            revoked: false
        };

        if (maxDownloads !== null) {
            filter.$or = [
                { downloadCount: { $exists: false } },
                { downloadCount: { $lt: maxDownloads } }
            ];
        }

        const updated = await Share.findOneAndUpdate(
            filter,
            {
                $inc: { downloadCount: 1 },
                $set: { lastDownloadedAt: new Date() }
            },
            { new: true }
        ).lean();

        if (!updated) {
            throw OrganizationPolicyService.createError('The download limit for this share has been reached.', 403, 'DOWNLOAD_LIMIT_REACHED');
        }

        return updated;
    }

    static async getActorOrganizationContext(userId, organizationId = null) {
        if (organizationId) {
            return OrganizationPolicyService.assertActiveMember(userId, organizationId);
        }

        const membership = await OrganizationPolicyService.getAnyActiveMembership(userId);
        if (!membership) {
            return null;
        }

        return OrganizationPolicyService.assertActiveMember(userId, membership.organizationId);
    }

    static async getUserOrgMembership(userId, organizationId) {
        return OrganizationMember.findOne({
            organizationId: organizationId.toString(),
            userId: userId.toString(),
            status: 'active'
        }).lean();
    }

    static async findUserTarget(identifier) {
        const value = normalizeText(identifier);
        if (!value) {
            return null;
        }

        return User.findOne({
            $or: [
                { username: value },
                { email: normalizeEmail(value) },
                { _id: value.match(/^[0-9a-f]{24}$/i) ? value : null }
            ].filter(condition => Object.values(condition)[0])
        }).select('_id username email').lean();
    }

    static async resolveTarget(actorUserId, organizationId, targetPayload = {}) {
        const targetType = targetPayload.targetType || 'member';

        if (targetType === 'member') {
            const targetUser = targetPayload.targetUserId
                ? await User.findById(targetPayload.targetUserId).select('_id username email').lean()
                : await this.findUserTarget(targetPayload.targetIdentifier || targetPayload.recipient || targetPayload.target);

            if (!targetUser) {
                throw OrganizationPolicyService.createError('Target member was not found.', 404, 'TARGET_MEMBER_NOT_FOUND');
            }

            if (safeId(targetUser._id) === actorUserId.toString()) {
                throw OrganizationPolicyService.createError('You cannot share an item directly with yourself.', 400, 'SELF_SHARE_BLOCKED');
            }

            const targetMembership = await this.getUserOrgMembership(targetUser._id, organizationId);
            const external = !targetMembership;

            return {
                targetType: 'member',
                targetId: safeId(targetUser._id),
                recipientId: safeId(targetUser._id),
                targetLabel: targetUser.email ? `${targetUser.username} <${targetUser.email}>` : targetUser.username,
                isExternalTarget: external,
                targetUser,
                external
            };
        }

        if (targetType === 'team') {
            const team = await Team.findOne({
                _id: targetPayload.targetId || targetPayload.teamId,
                organizationId: organizationId.toString(),
                status: 'active'
            }).lean();

            if (!team) {
                throw OrganizationPolicyService.createError('Target team was not found.', 404, 'TARGET_TEAM_NOT_FOUND');
            }

            return {
                targetType: 'team',
                targetId: safeId(team._id),
                recipientId: safeId(team._id),
                targetLabel: team.name,
                team,
                external: false
            };
        }

        if (targetType === 'organization') {
            const { organization } = await OrganizationPolicyService.assertActiveMember(actorUserId, organizationId);
            return {
                targetType: 'organization',
                targetId: organizationId.toString(),
                recipientId: organizationId.toString(),
                targetLabel: organization.name,
                external: false
            };
        }

        if (targetType === 'external') {
            const email = normalizeEmail(targetPayload.externalEmail || targetPayload.targetIdentifier || targetPayload.recipient || targetPayload.target);
            if (!email || !email.includes('@')) {
                throw OrganizationPolicyService.createError('A valid external email is required.', 400, 'EXTERNAL_EMAIL_REQUIRED');
            }

            return {
                targetType: 'external',
                targetId: email,
                recipientId: email,
                targetLabel: email,
                externalEmail: email,
                isExternalTarget: true,
                external: true
            };
        }

        throw OrganizationPolicyService.createError('Unsupported share target type.', 400, 'INVALID_SHARE_TARGET');
    }

    static getExpiryDate(options = {}) {
        if (options.expiresAt) {
            const date = new Date(options.expiresAt);
            return Number.isFinite(date.getTime()) ? date : null;
        }

        const minutes = Number(options.expiresInMinutes);
        if (Number.isFinite(minutes) && minutes > 0) {
            return new Date(Date.now() + Math.min(minutes, 365 * 24 * 60) * 60 * 1000);
        }

        const hours = Number(options.expiresInHours);
        if (Number.isFinite(hours) && hours > 0) {
            return new Date(Date.now() + Math.min(hours, 365 * 24) * 60 * 60 * 1000);
        }

        return null;
    }

    static async createShare(actorUserId, organizationId, payload = {}) {
        const { organization, membership } = await OrganizationPolicyService.assertActiveMember(actorUserId, organizationId);
        const itemType = payload.itemType || (payload.isFolder ? 'folder' : 'file');

        if (!['file', 'folder'].includes(itemType)) {
            throw OrganizationPolicyService.createError('Invalid item type.', 400, 'INVALID_ITEM_TYPE');
        }

        const item = await getItemByType(payload.itemId, itemType);
        if (!item) {
            throw OrganizationPolicyService.createError('Item not found.', 404, 'ITEM_NOT_FOUND');
        }

        if (item.workspaceType !== 'organization' || item.organizationId !== organizationId.toString()) {
            throw OrganizationPolicyService.createError('Only items in this organization workspace can be shared from this admin scope.', 403, 'ITEM_OUTSIDE_ORG_WORKSPACE');
        }

        const ownerMembership = await this.getUserOrgMembership(item.userId, organizationId);
        if (!ownerMembership) {
            throw OrganizationPolicyService.createError('Only items owned by organization members can be governed here.', 403, 'ITEM_OUTSIDE_ORG');
        }

        const actorIsAdmin = OrganizationPolicyService.hasOrgAdminRole(membership);
        if (item.userId.toString() !== actorUserId.toString() && !actorIsAdmin) {
            throw OrganizationPolicyService.createError('Only the item owner or an organization admin can share this item.', 403, 'ITEM_SHARE_FORBIDDEN');
        }

        const policy = await OrganizationPolicyService.getEffectiveSharingPolicy(actorUserId, organizationId);
        const target = await this.resolveTarget(actorUserId, organizationId, payload);
        const permissionPayload = normalizePermissionPayload(payload.permission, payload.permissions, policy.defaultPermission);
        const actorTeamMemberships = target.targetType === 'team'
            ? await OrganizationPolicyService.getActiveTeamMemberships(actorUserId, organizationId)
            : [];
        const actorTeamIds = actorTeamMemberships.map(teamMembership => safeId(teamMembership.teamId));

        permissionPayload.permissions.forEach(permission => {
            OrganizationPolicyService.assertPermissionAllowed(policy, permission);
        });
        OrganizationPolicyService.assertShareTargetAllowed(policy, target.targetType, {
            external: target.external,
            targetTeamId: target.targetId,
            actorTeamIds,
            actorIsOrgAdmin: actorIsAdmin
        });

        if (safeId(item.userId) !== actorUserId.toString() && policy.resharingAllowed === false) {
            throw OrganizationPolicyService.createError('Sharing items owned by another member is blocked by organization policy.', 403, 'RESHARING_BLOCKED');
        }

        const expiresAt = this.getExpiryDate(payload);
        if (target.external && policy.requireExternalExpiration && !expiresAt) {
            throw OrganizationPolicyService.createError('External shares must have an expiration date by organization policy.', 403, 'EXTERNAL_EXPIRY_REQUIRED');
        }

        const approvalStatus = target.external && policy.requireExternalApproval ? 'pending' : 'not_required';
        const maxDownloads = OrganizationPolicyService.getPolicyMaxDownloads(policy);
        const share = await Share.findOneAndUpdate(
            {
                ownerId: item.userId.toString(),
                workspaceId: item.workspaceId || null,
                workspaceType: item.workspaceType || null,
                recipientId: target.recipientId,
                itemId: item._id.toString(),
                itemType
            },
            {
                ownerId: item.userId.toString(),
                workspaceId: item.workspaceId || null,
                workspaceType: item.workspaceType || null,
                recipientId: target.recipientId,
                targetType: target.targetType,
                targetId: target.targetId,
                targetLabel: target.targetLabel,
                organizationId: organizationId.toString(),
                createdBy: actorUserId.toString(),
                itemId: item._id.toString(),
                itemType,
                permission: permissionPayload.permission,
                permissions: permissionPayload.permissions,
                isExternalTarget: target.external === true,
                approvalStatus,
                expiresAt,
                maxDownloads,
                revoked: false
            },
            {
                upsert: true,
                new: true,
                setDefaultsOnInsert: true
            }
        );

        await OrganizationService.writeAudit(organization._id, actorUserId, 'share.created', 'share', share._id, {
            itemId: item._id.toString(),
            itemType,
            itemName: item.name,
            targetType: target.targetType,
            targetLabel: target.targetLabel,
            permission: permissionPayload.permission,
            permissions: permissionPayload.permissions
        });

        await ActivityEventService.recordShareCreated({
            actorUserId,
            ownerId: item.userId.toString(),
            recipientId: target.targetType === 'member' && target.targetUser
                ? target.targetUser._id.toString()
                : null,
            targetType: target.targetType,
            targetLabel: target.targetLabel,
            item,
            itemType,
            shareId: share._id.toString(),
            permission: permissionPayload.permission,
            permissions: permissionPayload.permissions,
            expiresAt
        }).catch(error => {
            console.error('Failed to record organization share activity:', error.message);
        });

        return this.serializeShare(share.toObject(), {
            item,
            organization,
            targetUser: target.targetUser || null,
            owner: null,
            creator: null
        });
    }

    static async createMemberShareWithPolicy(ownerId, itemId, isFolder, recipient, permission = 'download', expiryOptions = {}) {
        const actorContext = await this.getActorOrganizationContext(ownerId);
        if (!actorContext) {
            return null;
        }

        return this.createShare(ownerId, actorContext.organization._id, {
            itemId,
            itemType: isFolder ? 'folder' : 'file',
            targetType: 'member',
            targetIdentifier: recipient,
            permission,
            expiresInHours: expiryOptions.expiresInHours,
            expiresInMinutes: expiryOptions.expiresInMinutes
        });
    }

    static async listShareTargets(actorUserId, organizationId) {
        const policy = await OrganizationPolicyService.getEffectiveSharingPolicy(actorUserId, organizationId);
        const [members, teams, organization, actorTeamMemberships, actorMembership] = await Promise.all([
            OrganizationMember.find({
                organizationId: organizationId.toString(),
                status: 'active',
                userId: { $ne: null }
            }).lean(),
            Team.find({ organizationId: organizationId.toString(), status: 'active' }).sort({ name: 1 }).lean(),
            OrganizationPolicyService.getOrganization(organizationId),
            OrganizationPolicyService.getActiveTeamMemberships(actorUserId, organizationId),
            OrganizationPolicyService.getActiveMembership(actorUserId, organizationId)
        ]);
        const actorTeamIds = actorTeamMemberships.map(teamMembership => safeId(teamMembership.teamId));
        const actorIsOrgAdmin = OrganizationPolicyService.hasOrgAdminRole(actorMembership);
        const visibleTeams = policy.teamSharingAllowed === false
            ? []
            : (policy.teamToTeamSharingAllowed === false && actorTeamIds.length && !actorIsOrgAdmin
                ? teams.filter(team => actorTeamIds.includes(safeId(team._id)))
                : teams);
        const userIds = members.map(member => member.userId);
        const users = userIds.length
            ? await User.find({ _id: { $in: userIds } }).select('_id username email').lean()
            : [];
        const usersById = users.reduce((result, user) => {
            result[safeId(user._id)] = user;
            return result;
        }, {});

        return {
            organization: organization && policy.organizationSharingAllowed !== false
                ? { id: safeId(organization._id), name: organization.name }
                : null,
            policy,
            members: policy.memberSharingAllowed === false ? [] : members
                .filter(member => usersById[member.userId])
                .map(member => {
                    const user = usersById[member.userId];
                    return {
                        id: safeId(user._id),
                        name: user.username,
                        email: user.email,
                        label: user.email ? `${user.username} <${user.email}>` : user.username
                    };
                })
                .sort((a, b) => a.name.localeCompare(b.name)),
            teams: visibleTeams.map(team => ({
                id: safeId(team._id),
                name: team.name,
                label: team.name
            }))
        };
    }

    static getUserShareFilter(userId, memberships = [], teamIds = []) {
        const organizationIds = memberships.map(membership => membership.organizationId);

        return {
            revoked: false,
            $and: [activeDateClause()],
            $or: [
                { targetType: { $in: [null, 'member'] }, recipientId: userId.toString() },
                { targetType: 'team', targetId: { $in: teamIds } },
                { targetType: 'organization', targetId: { $in: organizationIds } }
            ]
        };
    }

    static async filterSharesByCurrentPolicy(shares) {
        const policyCache = {};
        const filtered = [];

        for (const share of shares) {
            if (!share.organizationId) {
                filtered.push(share);
                continue;
            }

            const cacheKey = `${share.organizationId}:${share.ownerId}`;
            if (!Object.prototype.hasOwnProperty.call(policyCache, cacheKey)) {
                try {
                    policyCache[cacheKey] = await OrganizationPolicyService.getEffectiveSharingPolicy(share.ownerId, share.organizationId);
                } catch (error) {
                    policyCache[cacheKey] = null;
                }
            }

            if (!policyCache[cacheKey]) {
                continue;
            }

            const policyShare = applyCurrentPolicyToShare(share, policyCache[cacheKey]);
            if (policyShare) {
                filtered.push(policyShare);
            }
        }

        return filtered;
    }

    static async getSharesForUser(userId, extra = {}) {
        const memberships = await OrganizationPolicyService.getActiveMembershipsForUser(userId);
        const teamMemberships = memberships.length
            ? await TeamMember.find({
                organizationId: { $in: memberships.map(membership => membership.organizationId) },
                userId: userId.toString(),
                status: 'active'
            }).lean()
            : [];
        const teamIds = teamMemberships.map(teamMembership => teamMembership.teamId);

        const shares = await Share.find({
            ...this.getUserShareFilter(userId, memberships, teamIds),
            ...extra
        }).sort({ updatedAt: -1 }).lean();
        const policyFilteredShares = await this.filterSharesByCurrentPolicy(shares);
        const deduped = {};

        policyFilteredShares.forEach(share => {
            const key = `${share.itemType}:${share.itemId}`;
            if (!deduped[key] || scoreShare(share) > scoreShare(deduped[key])) {
                deduped[key] = share;
            }
        });

        return Object.values(deduped);
    }

    static async getDirectAccessShare(userId, itemId, itemType) {
        const shares = await this.getSharesForUser(userId, {
            itemId: itemId.toString(),
            itemType
        });

        return shares[0] || null;
    }

    static async getSharedAncestorShare(userId, item) {
        let currentFolderId = item.parent_id;

        while (currentFolderId) {
            const folder = await Folder.findOne({ _id: currentFolderId, deleted: false })
                .select('_id parent_id')
                .lean();

            if (!folder) {
                return null;
            }

            const share = await this.getDirectAccessShare(userId, folder._id, 'folder');
            if (share) {
                return share;
            }

            currentFolderId = folder.parent_id;
        }

        return null;
    }

    static async getAccessShareForItem(userId, item, itemType) {
        if (!item || item.userId.toString() === userId.toString()) {
            return null;
        }

        return await this.getDirectAccessShare(userId, item._id, itemType) ||
            await this.getSharedAncestorShare(userId, item);
    }

    static async revokeShare(actorUserId, organizationId, shareId) {
        const context = await OrganizationPolicyService.assertActiveMember(actorUserId, organizationId);
        const share = await Share.findOne({
            _id: shareId,
            organizationId: organizationId.toString(),
            revoked: false
        });

        if (!share) {
            throw OrganizationPolicyService.createError('Share not found.', 404, 'SHARE_NOT_FOUND');
        }

        const canManage = OrganizationPolicyService.hasOrgAdminRole(context.membership) ||
            share.ownerId === actorUserId.toString() ||
            share.createdBy === actorUserId.toString();

        if (!canManage) {
            throw OrganizationPolicyService.createError('You cannot revoke this share.', 403, 'SHARE_REVOKE_DENIED');
        }

        share.revoked = true;
        await share.save();

        await OrganizationService.writeAudit(organizationId, actorUserId, 'share.revoked', 'share', share._id, {
            itemId: share.itemId,
            itemType: share.itemType,
            targetType: share.targetType,
            targetLabel: share.targetLabel
        });

        const item = await getItemByType(share.itemId, share.itemType);
        if (item) {
            await ActivityEventService.recordShareRevoked({
                actorUserId,
                ownerId: share.ownerId,
                recipientId: share.targetType === 'member' ? share.recipientId : null,
                targetType: share.targetType || 'member',
                targetLabel: share.targetLabel,
                item,
                itemType: share.itemType,
                shareId: share._id.toString()
            }).catch(error => {
                console.error('Failed to record organization share revocation activity:', error.message);
            });
        }

        return { success: true };
    }

    static async updateShare(actorUserId, organizationId, shareId, payload = {}) {
        await OrganizationPolicyService.assertOrgAdmin(actorUserId, organizationId);
        const share = await Share.findOne({
            _id: shareId,
            organizationId: organizationId.toString(),
            revoked: false
        });

        if (!share) {
            throw OrganizationPolicyService.createError('Share not found.', 404, 'SHARE_NOT_FOUND');
        }

        const policy = await OrganizationPolicyService.getEffectiveSharingPolicy(actorUserId, organizationId);
        const permissionPayload = normalizePermissionPayload(payload.permission || share.permission, payload.permissions, policy.defaultPermission);
        permissionPayload.permissions.forEach(permission => {
            OrganizationPolicyService.assertPermissionAllowed(policy, permission);
        });

        share.permission = permissionPayload.permission;
        share.permissions = permissionPayload.permissions;
        share.maxDownloads = OrganizationPolicyService.getPolicyMaxDownloads(policy);

        if (payload.expiresAt !== undefined || payload.expiresInMinutes !== undefined || payload.expiresInHours !== undefined) {
            share.expiresAt = this.getExpiryDate(payload);
        }

        if (!isExternalShareTarget(share)) {
            share.approvalStatus = 'not_required';
        } else if (payload.approvalStatus && ['not_required', 'pending', 'approved', 'rejected'].includes(payload.approvalStatus)) {
            share.approvalStatus = payload.approvalStatus;
        }

        await share.save();
        await OrganizationService.writeAudit(organizationId, actorUserId, 'share.updated', 'share', share._id, {
            itemId: share.itemId,
            itemType: share.itemType,
            targetType: share.targetType,
            targetLabel: share.targetLabel,
            permission: share.permission,
            permissions: share.permissions
        });

        return this.serializeShare(share.toObject());
    }

    static getProposedSettings(organization, payload = {}) {
        const currentSettings = OrganizationPolicyService.normalizeSettings((organization || {}).settings || {});
        const incomingSettings = payload.settings && typeof payload.settings === 'object'
            ? payload.settings
            : payload;

        return OrganizationPolicyService.normalizeSettings({
            ...currentSettings,
            ...incomingSettings,
            sharing: {
                ...currentSettings.sharing,
                ...((incomingSettings || {}).sharing || {})
            },
            quotas: {
                ...currentSettings.quotas,
                ...((incomingSettings || {}).quotas || {})
            },
            onboarding: {
                ...currentSettings.onboarding,
                ...((incomingSettings || {}).onboarding || {})
            }
        });
    }

    static async getEffectivePolicyForOwnerWithSettings(ownerId, organizationId, organization, settings) {
        const membership = await OrganizationMember.findOne({
            organizationId: organizationId.toString(),
            userId: ownerId.toString(),
            status: 'active'
        }).lean();

        if (!membership) {
            return null;
        }

        let policy = OrganizationPolicyService.normalizeSharingPolicy(settings.sharing);

        if (settings.allowTeamPolicyOverrides !== false) {
            const teamMemberships = await TeamMember.find({
                organizationId: organizationId.toString(),
                userId: ownerId.toString(),
                status: 'active'
            }).lean();
            const teamIds = teamMemberships.map(teamMembership => teamMembership.teamId);
            const teams = teamIds.length
                ? await Team.find({ _id: { $in: teamIds }, organizationId: organizationId.toString(), status: 'active' }).lean()
                : [];

            teams.forEach(team => {
                policy = OrganizationPolicyService.mergeRestrictiveSharingPolicy(policy, (team.settings || {}).sharing || {});
            });
        }

        return OrganizationPolicyService.mergeRestrictiveSharingPolicy(
            policy,
            (membership.settings || {}).sharing || {},
            { strictOnly: true }
        );
    }

    static async simulatePolicy(actorUserId, organizationId, payload = {}) {
        await OrganizationPolicyService.assertManageableOrgAdmin(actorUserId, organizationId);
        const organization = await OrganizationPolicyService.getOrganization(organizationId);
        if (!organization) {
            throw OrganizationPolicyService.createError('Organization not found.', 404, 'ORG_NOT_FOUND');
        }

        const proposedSettings = this.getProposedSettings(organization, payload);
        const [shares, publicLinks] = await Promise.all([
            Share.find({
                organizationId: organizationId.toString(),
                revoked: false,
                $and: [activeDateClause()]
            }).sort({ updatedAt: -1 }).limit(1000).lean(),
            ShareLink.find({
                organizationId: organizationId.toString(),
                revoked: false,
                $and: [activeDateClause()]
            }).sort({ updatedAt: -1 }).limit(1000).lean()
        ]);
        const ownerPolicyCache = {};
        const reasonCounts = {};
        const affectedShares = [];
        const affectedPublicLinks = [];
        let downloadLimitedShares = 0;
        let downloadLimitedPublicLinks = 0;

        const getOwnerPolicy = async ownerId => {
            const key = ownerId.toString();
            if (!Object.prototype.hasOwnProperty.call(ownerPolicyCache, key)) {
                ownerPolicyCache[key] = await this.getEffectivePolicyForOwnerWithSettings(
                    ownerId,
                    organizationId,
                    organization,
                    proposedSettings
                );
            }
            return ownerPolicyCache[key];
        };

        for (const share of shares) {
            const policy = await getOwnerPolicy(share.ownerId);
            if (!policy) {
                reasonCounts.owner_inactive = (reasonCounts.owner_inactive || 0) + 1;
                affectedShares.push({
                    id: safeId(share._id),
                    kind: 'share',
                    itemId: share.itemId,
                    itemType: share.itemType,
                    targetType: share.targetType || 'member',
                    targetLabel: share.targetLabel || share.recipientId,
                    reasons: ['owner_inactive'],
                    downloadCount: getDownloadCount(share),
                    maxDownloads: null
                });
                continue;
            }

            const maxDownloads = OrganizationPolicyService.getPolicyMaxDownloads(policy);
            if (maxDownloads !== null && canDownloadFromPermissions(getSharePermissions(share))) {
                downloadLimitedShares += 1;
            }

            const reasons = evaluateShareAgainstPolicy(share, policy, reasonCounts);
            if (reasons.length) {
                affectedShares.push({
                    id: safeId(share._id),
                    kind: 'share',
                    itemId: share.itemId,
                    itemType: share.itemType,
                    targetType: share.targetType || 'member',
                    targetLabel: share.targetLabel || share.recipientId,
                    reasons,
                    downloadCount: getDownloadCount(share),
                    maxDownloads
                });
            }
        }

        for (const link of publicLinks) {
            const policy = await getOwnerPolicy(link.ownerId);
            if (!policy) {
                reasonCounts.owner_inactive = (reasonCounts.owner_inactive || 0) + 1;
                affectedPublicLinks.push({
                    id: safeId(link._id),
                    kind: 'publicLink',
                    itemId: link.itemId,
                    itemType: link.itemType,
                    targetLabel: 'Anyone with link',
                    reasons: ['owner_inactive'],
                    downloadCount: getDownloadCount(link),
                    maxDownloads: null
                });
                continue;
            }

            const maxDownloads = OrganizationPolicyService.getPolicyMaxDownloads(policy);
            if (maxDownloads !== null && link.permission === 'download') {
                downloadLimitedPublicLinks += 1;
            }

            const reasons = evaluatePublicLinkAgainstPolicy(link, policy, reasonCounts);
            if (reasons.length) {
                affectedPublicLinks.push({
                    id: safeId(link._id),
                    kind: 'publicLink',
                    itemId: link.itemId,
                    itemType: link.itemType,
                    targetLabel: 'Anyone with link',
                    reasons,
                    downloadCount: getDownloadCount(link),
                    maxDownloads
                });
            }
        }

        return {
            proposedPolicy: proposedSettings.sharing,
            totals: {
                directShares: shares.length,
                publicLinks: publicLinks.length,
                affectedDirectShares: affectedShares.length,
                affectedPublicLinks: affectedPublicLinks.length,
                downloadLimitedDirectShares: downloadLimitedShares,
                downloadLimitedPublicLinks
            },
            reasonCounts,
            affectedShares: affectedShares.slice(0, 25),
            affectedPublicLinks: affectedPublicLinks.slice(0, 25),
            truncated: affectedShares.length > 25 || affectedPublicLinks.length > 25
        };
    }

    static async listOrganizationShares(actorUserId, organizationId, filters = {}) {
        await OrganizationPolicyService.assertManageableOrgAdmin(actorUserId, organizationId);
        const query = {
            organizationId: organizationId.toString(),
            revoked: filters.includeRevoked === true ? { $in: [true, false] } : false
        };

        if (filters.targetType) {
            query.targetType = filters.targetType;
        }

        if (filters.externalOnly === true || filters.externalOnly === 'true') {
            query.isExternalTarget = true;
        }

        if (filters.permission) {
            query.$or = [
                { permission: filters.permission },
                { permissions: filters.permission }
            ];
        }

        const shares = await Share.find(query).sort({ updatedAt: -1 }).limit(500).lean();
        const publicLinks = await ShareLink.find({
            organizationId: organizationId.toString(),
            revoked: false
        }).sort({ updatedAt: -1 }).limit(200).lean();

        return {
            shares: await this.enrichShares(shares),
            publicLinks: await this.enrichPublicLinks(publicLinks)
        };
    }

    static async enrichShares(shares) {
        const userIds = Array.from(new Set(shares.flatMap(share => [share.ownerId, share.createdBy, share.targetType === 'member' ? share.recipientId : null]).filter(Boolean)));
        const teamIds = Array.from(new Set(shares.filter(share => share.targetType === 'team').map(share => share.targetId || share.recipientId).filter(Boolean)));
        const itemIdsByType = shares.reduce((result, share) => {
            result[share.itemType].push(share.itemId);
            return result;
        }, { file: [], folder: [] });
        const [users, teams, files, folders] = await Promise.all([
            userIds.length ? User.find({ _id: { $in: userIds } }).select('_id username email').lean() : [],
            teamIds.length ? Team.find({ _id: { $in: teamIds } }).select('_id name').lean() : [],
            itemIdsByType.file.length ? File.find({ _id: { $in: itemIdsByType.file } }).select('_id name path size userId deleted').lean() : [],
            itemIdsByType.folder.length ? Folder.find({ _id: { $in: itemIdsByType.folder } }).select('_id name path size userId deleted').lean() : []
        ]);
        const usersById = users.reduce((result, user) => {
            result[safeId(user._id)] = user;
            return result;
        }, {});
        const teamsById = teams.reduce((result, team) => {
            result[safeId(team._id)] = team;
            return result;
        }, {});
        const itemsById = files.concat(folders).reduce((result, item) => {
            result[safeId(item._id)] = item;
            return result;
        }, {});
        const policyCache = {};

        return Promise.all(shares.map(async share => {
            let enrichedShare = share;

            if (share.organizationId) {
                const cacheKey = `${share.organizationId}:${share.ownerId}`;
                if (!Object.prototype.hasOwnProperty.call(policyCache, cacheKey)) {
                    try {
                        policyCache[cacheKey] = await OrganizationPolicyService.getEffectiveSharingPolicy(share.ownerId, share.organizationId);
                    } catch (error) {
                        policyCache[cacheKey] = null;
                    }
                }

                if (policyCache[cacheKey]) {
                    const effectiveMaxDownloads = OrganizationPolicyService.getPolicyMaxDownloads(policyCache[cacheKey]);
                    enrichedShare = {
                        ...share,
                        effectiveMaxDownloads,
                        downloadLimitReached: isDownloadLimitReached(share, policyCache[cacheKey])
                    };
                }
            }

            return this.serializeShare(enrichedShare, {
                owner: usersById[share.ownerId],
                creator: usersById[share.createdBy],
                targetUser: share.targetType === 'member' ? usersById[share.recipientId] : null,
                team: share.targetType === 'team' ? teamsById[share.targetId || share.recipientId] : null,
                item: itemsById[share.itemId]
            });
        }));
    }

    static async enrichPublicLinks(links) {
        const userIds = Array.from(new Set(links.map(link => link.ownerId).filter(Boolean)));
        const itemIdsByType = links.reduce((result, link) => {
            result[link.itemType].push(link.itemId);
            return result;
        }, { file: [], folder: [] });
        const [users, files, folders] = await Promise.all([
            userIds.length ? User.find({ _id: { $in: userIds } }).select('_id username email').lean() : [],
            itemIdsByType.file.length ? File.find({ _id: { $in: itemIdsByType.file } }).select('_id name path size userId deleted').lean() : [],
            itemIdsByType.folder.length ? Folder.find({ _id: { $in: itemIdsByType.folder } }).select('_id name path size userId deleted').lean() : []
        ]);
        const usersById = users.reduce((result, user) => {
            result[safeId(user._id)] = user;
            return result;
        }, {});
        const itemsById = files.concat(folders).reduce((result, item) => {
            result[safeId(item._id)] = item;
            return result;
        }, {});
        const policyCache = {};

        return Promise.all(links.map(async link => {
            let maxDownloads = link.maxDownloads || null;
            if (link.organizationId) {
                const cacheKey = `${link.organizationId}:${link.ownerId}`;
                if (!Object.prototype.hasOwnProperty.call(policyCache, cacheKey)) {
                    try {
                        const policy = await OrganizationPolicyService.getEffectiveSharingPolicy(link.ownerId, link.organizationId);
                        policyCache[cacheKey] = OrganizationPolicyService.getPolicyMaxDownloads(policy);
                    } catch (error) {
                        policyCache[cacheKey] = null;
                    }
                }
                maxDownloads = policyCache[cacheKey];
            }

            return {
                id: safeId(link._id),
                kind: 'publicLink',
                ownerId: link.ownerId,
                ownerName: usersById[link.ownerId] ? usersById[link.ownerId].username : 'Unknown user',
                itemId: link.itemId,
                itemType: link.itemType,
                itemName: itemsById[link.itemId] ? itemsById[link.itemId].name : 'Missing item',
                itemPath: itemsById[link.itemId] ? itemsById[link.itemId].path : '',
                itemDeleted: itemsById[link.itemId] ? itemsById[link.itemId].deleted === true : true,
                targetType: 'external',
                targetLabel: 'Anyone with link',
                permission: link.permission,
                permissions: [link.permission],
                shareStatus: itemsById[link.itemId] && itemsById[link.itemId].deleted === true
                    ? 'Item deleted'
                    : (link.expiresAt && link.expiresAt <= new Date() ? 'Expired' : 'Active'),
                isExternalTarget: true,
                risky: true,
                riskReason: 'Public link grants access outside the organization boundary.',
                expiresAt: link.expiresAt,
                createdAt: link.createdAt,
                updatedAt: link.updatedAt,
                accessCount: link.accessCount || 0,
                maxDownloads,
                downloadCount: link.downloadCount || 0,
                lastDownloadedAt: link.lastDownloadedAt || null,
                downloadLimitReached: isDownloadLimitReached({ ...link, effectiveMaxDownloads: maxDownloads })
            };
        }));
    }

    static serializeShare(share, refs = {}) {
        const targetType = share.targetType || 'member';
        const external = isExternalShareTarget(share);
        const approvalPending = external && share.approvalStatus === 'pending';
        const approvalRejected = external && share.approvalStatus === 'rejected';
        let targetLabel = share.targetLabel || '';
        const expired = !!(share.expiresAt && share.expiresAt <= new Date());
        const itemDeleted = refs.item ? refs.item.deleted === true : false;
        const shareStatus = share.revoked === true
            ? 'Revoked'
            : itemDeleted
                ? 'Item deleted'
                : expired
                ? 'Expired'
                : approvalPending
                    ? 'Pending approval'
                    : approvalRejected
                    ? 'Rejected'
                    : 'Active';

        if (!targetLabel && targetType === 'member' && refs.targetUser) {
            targetLabel = refs.targetUser.email
                ? `${refs.targetUser.username} <${refs.targetUser.email}>`
                : refs.targetUser.username;
        }

        if (!targetLabel && targetType === 'team' && refs.team) {
            targetLabel = refs.team.name;
        }

        return {
            id: safeId(share._id),
            kind: 'share',
            organizationId: share.organizationId || null,
            ownerId: share.ownerId,
            ownerName: refs.owner ? refs.owner.username : '',
            createdBy: share.createdBy || share.ownerId,
            creatorName: refs.creator ? refs.creator.username : '',
            recipientId: share.recipientId,
            targetType,
            targetId: share.targetId || share.recipientId,
            targetLabel,
            itemId: share.itemId,
            itemType: share.itemType,
            itemName: refs.item ? refs.item.name : '',
            itemPath: refs.item ? refs.item.path : '',
            itemSize: refs.item ? refs.item.size : 0,
            itemDeleted,
            permission: share.permission,
            permissions: Array.isArray(share.permissions) && share.permissions.length ? share.permissions : [share.permission || 'view'],
            approvalStatus: external ? (share.approvalStatus || 'not_required') : 'not_required',
            shareStatus,
            isExternalTarget: external,
            risky: external || approvalPending,
            riskReason: external
                ? 'External share'
                : '',
            expiresAt: share.expiresAt || null,
            maxDownloads: share.effectiveMaxDownloads !== undefined ? share.effectiveMaxDownloads : (share.maxDownloads || null),
            downloadCount: share.downloadCount || 0,
            lastDownloadedAt: share.lastDownloadedAt || null,
            downloadLimitReached: share.downloadLimitReached === true || isDownloadLimitReached(share),
            revoked: share.revoked === true,
            createdAt: share.createdAt,
            updatedAt: share.updatedAt
        };
    }
}

module.exports = OrganizationShareService;
