const Organization = require('../models/organizationModel');
const OrganizationMember = require('../models/organizationMemberModel');
const Team = require('../models/teamModel');
const TeamMember = require('../models/teamMemberModel');

const ROLE = {
    OWNER: 'owner',
    ADMIN: 'admin',
    TEAM_ADMIN: 'teamAdmin',
    MEMBER: 'member'
};

const SHARE_PERMISSIONS = ['view', 'download', 'upload', 'edit', 'reshare', 'manage'];

const DEFAULT_SHARING_POLICY = {
    memberSharingAllowed: true,
    teamSharingAllowed: true,
    organizationSharingAllowed: true,
    teamToTeamSharingAllowed: true,
    externalSharingAllowed: true,
    publicLinkSharingAllowed: true,
    requireExternalExpiration: false,
    requireExternalApproval: false,
    resharingAllowed: true,
    defaultPermission: 'download',
    allowedPermissions: ['view', 'download'],
    downloadLimitEnabled: false,
    maxDownloads: null
};

const DEFAULT_ORG_SETTINGS = {
    allowTeamPolicyOverrides: true,
    sharing: DEFAULT_SHARING_POLICY,
    quotas: {
        defaultMemberQuotaBytes: null
    },
    onboarding: {
        inviteOnly: true
    }
};

function createPolicyError(message, statusCode = 403, code = 'ORG_POLICY_DENIED') {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.code = code;
    return error;
}

function unique(values) {
    return Array.from(new Set((values || []).filter(Boolean)));
}

function clone(value) {
    return JSON.parse(JSON.stringify(value || {}));
}

function normalizePermissions(permissions) {
    const normalized = unique(permissions).filter(permission => SHARE_PERMISSIONS.includes(permission));
    return normalized.length ? normalized : ['view'];
}

function normalizeMaxDownloads(value) {
    const parsed = parseInt(value, 10);

    if (!Number.isFinite(parsed) || parsed <= 0) {
        return null;
    }

    return Math.min(parsed, 1000000);
}

function normalizeSharingPolicy(policy = {}) {
    const merged = {
        ...DEFAULT_SHARING_POLICY,
        ...(policy || {})
    };

    merged.allowedPermissions = normalizePermissions(merged.allowedPermissions || DEFAULT_SHARING_POLICY.allowedPermissions);
    merged.maxDownloads = normalizeMaxDownloads(merged.maxDownloads);
    merged.downloadLimitEnabled = merged.downloadLimitEnabled === true && merged.maxDownloads !== null;

    if (!merged.allowedPermissions.includes(merged.defaultPermission)) {
        merged.defaultPermission = merged.allowedPermissions.includes('download') ? 'download' : merged.allowedPermissions[0];
    }

    return merged;
}

function normalizeSettings(settings = {}) {
    const merged = {
        ...clone(DEFAULT_ORG_SETTINGS),
        ...(settings || {})
    };

    merged.sharing = normalizeSharingPolicy({
        ...DEFAULT_SHARING_POLICY,
        ...((settings || {}).sharing || {})
    });

    merged.quotas = {
        ...DEFAULT_ORG_SETTINGS.quotas,
        ...((settings || {}).quotas || {})
    };

    merged.onboarding = {
        ...DEFAULT_ORG_SETTINGS.onboarding,
        ...((settings || {}).onboarding || {})
    };

    return merged;
}

function mergeRestrictiveSharingPolicy(basePolicy, overridePolicy = {}, options = {}) {
    const base = normalizeSharingPolicy(basePolicy);
    const override = overridePolicy || {};
    const strictOnly = options.strictOnly === true;
    const next = { ...base };
    const booleanKeys = [
        'memberSharingAllowed',
        'teamSharingAllowed',
        'organizationSharingAllowed',
        'teamToTeamSharingAllowed',
        'externalSharingAllowed',
        'publicLinkSharingAllowed',
        'requireExternalExpiration',
        'requireExternalApproval',
        'resharingAllowed'
    ];

    booleanKeys.forEach(function(key) {
        if (typeof override[key] !== 'boolean') {
            return;
        }

        if (key.startsWith('require')) {
            next[key] = Boolean(base[key] || override[key]);
            return;
        }

        next[key] = strictOnly
            ? Boolean(base[key] && override[key])
            : Boolean(base[key] && override[key]);
    });

    if (Array.isArray(override.allowedPermissions) && override.allowedPermissions.length) {
        const allowed = normalizePermissions(override.allowedPermissions);
        next.allowedPermissions = base.allowedPermissions.filter(permission => allowed.includes(permission));
        if (!next.allowedPermissions.length) {
            next.allowedPermissions = ['view'];
        }
    }

    if (override.defaultPermission && next.allowedPermissions.includes(override.defaultPermission)) {
        next.defaultPermission = override.defaultPermission;
    } else if (!next.allowedPermissions.includes(next.defaultPermission)) {
        next.defaultPermission = next.allowedPermissions.includes('download') ? 'download' : next.allowedPermissions[0];
    }

    const baseLimit = base.downloadLimitEnabled ? normalizeMaxDownloads(base.maxDownloads) : null;
    const overrideLimit = normalizeMaxDownloads(override.maxDownloads);
    const overrideEnablesLimit = override.downloadLimitEnabled === true && overrideLimit !== null;

    if (baseLimit !== null || overrideEnablesLimit) {
        next.downloadLimitEnabled = true;
        next.maxDownloads = [baseLimit, overrideLimit]
            .filter(value => value !== null)
            .reduce((lowest, value) => lowest === null ? value : Math.min(lowest, value), null);
    }

    return normalizeSharingPolicy(next);
}

function roleSet(roles = []) {
    return new Set(unique(roles.length ? roles : [ROLE.MEMBER]));
}

class OrganizationPolicyService {
    static ROLE = ROLE;
    static SHARE_PERMISSIONS = SHARE_PERMISSIONS;

    static normalizeSettings(settings) {
        return normalizeSettings(settings);
    }

    static normalizeSharingPolicy(policy) {
        return normalizeSharingPolicy(policy);
    }

    static normalizeMaxDownloads(value) {
        return normalizeMaxDownloads(value);
    }

    static getPolicyMaxDownloads(policy) {
        const normalized = normalizeSharingPolicy(policy);
        return normalized.downloadLimitEnabled ? normalized.maxDownloads : null;
    }

    static mergeRestrictiveSharingPolicy(basePolicy, overridePolicy = {}, options = {}) {
        return mergeRestrictiveSharingPolicy(basePolicy, overridePolicy, options);
    }

    static normalizePermissions(permissions, fallback = ['view']) {
        const normalized = normalizePermissions(permissions);
        return normalized.length ? normalized : fallback;
    }

    static createError(message, statusCode = 403, code = 'ORG_POLICY_DENIED') {
        return createPolicyError(message, statusCode, code);
    }

    static hasOrgAdminRole(member) {
        const roles = roleSet(member && member.roles);
        return roles.has(ROLE.OWNER) || roles.has(ROLE.ADMIN);
    }

    static hasTeamAdminRole(member) {
        const roles = roleSet(member && member.roles);
        return roles.has(ROLE.OWNER) || roles.has(ROLE.ADMIN) || roles.has(ROLE.TEAM_ADMIN);
    }

    static async getOrganization(organizationId) {
        if (!organizationId) {
            return null;
        }

        return Organization.findOne({ _id: organizationId, status: { $ne: 'archived' } });
    }

    static async getActiveMembership(userId, organizationId) {
        if (!userId || !organizationId) {
            return null;
        }

        return OrganizationMember.findOne({
            organizationId: organizationId.toString(),
            userId: userId.toString(),
            status: 'active'
        });
    }

    static async getAnyActiveMembership(userId) {
        if (!userId) {
            return null;
        }

        return OrganizationMember.findOne({
            userId: userId.toString(),
            status: 'active'
        }).sort({ updatedAt: -1 });
    }

    static async getActiveMembershipsForUser(userId) {
        if (!userId) {
            return [];
        }

        return OrganizationMember.find({
            userId: userId.toString(),
            status: 'active'
        }).lean();
    }

    static async assertActiveMember(userId, organizationId) {
        const [organization, membership] = await Promise.all([
            this.getOrganization(organizationId),
            this.getActiveMembership(userId, organizationId)
        ]);

        if (!organization) {
            throw createPolicyError('Organization does not exist.', 404, 'ORG_NOT_FOUND');
        }

        if (organization.status !== 'active') {
            throw createPolicyError('Organization is suspended.', 403, 'ORG_SUSPENDED');
        }

        if (!membership) {
            throw createPolicyError('You are not an active member of this organization.', 403, 'ORG_MEMBER_REQUIRED');
        }

        return { organization, membership };
    }

    static async assertReadableMember(userId, organizationId) {
        const [organization, membership] = await Promise.all([
            this.getOrganization(organizationId),
            this.getActiveMembership(userId, organizationId)
        ]);

        if (!organization) {
            throw createPolicyError('Organization does not exist.', 404, 'ORG_NOT_FOUND');
        }

        if (!membership) {
            throw createPolicyError('You are not an active member of this organization.', 403, 'ORG_MEMBER_REQUIRED');
        }

        return { organization, membership };
    }

    static async assertOrgAdmin(userId, organizationId) {
        const context = await this.assertActiveMember(userId, organizationId);

        if (!this.hasOrgAdminRole(context.membership)) {
            throw createPolicyError('Organization admin permissions are required.', 403, 'ORG_ADMIN_REQUIRED');
        }

        return context;
    }

    static async assertManageableOrgAdmin(userId, organizationId) {
        const context = await this.assertReadableMember(userId, organizationId);

        if (!this.hasOrgAdminRole(context.membership)) {
            throw createPolicyError('Organization admin permissions are required.', 403, 'ORG_ADMIN_REQUIRED');
        }

        return context;
    }

    static async assertOrgOwner(userId, organizationId) {
        const context = await this.assertActiveMember(userId, organizationId);
        const roles = roleSet(context.membership.roles);

        if (!roles.has(ROLE.OWNER)) {
            throw createPolicyError('Organization owner permissions are required.', 403, 'ORG_OWNER_REQUIRED');
        }

        return context;
    }

    static async assertReadableTeamAdmin(userId, organizationId, teamId) {
        const context = await this.assertReadableMember(userId, organizationId);

        if (this.hasOrgAdminRole(context.membership)) {
            return context;
        }

        const teamMembership = await TeamMember.findOne({
            organizationId: organizationId.toString(),
            teamId: teamId.toString(),
            userId: userId.toString(),
            role: 'admin',
            status: 'active'
        }).lean();

        if (!teamMembership) {
            throw createPolicyError('Team admin permissions are required.', 403, 'TEAM_ADMIN_REQUIRED');
        }

        return {
            ...context,
            teamMembership
        };
    }

    static async assertTeamAdmin(userId, organizationId, teamId) {
        const context = await this.assertActiveMember(userId, organizationId);

        if (this.hasOrgAdminRole(context.membership)) {
            return context;
        }

        const teamMembership = await TeamMember.findOne({
            organizationId: organizationId.toString(),
            teamId: teamId.toString(),
            userId: userId.toString(),
            role: 'admin',
            status: 'active'
        }).lean();

        if (!teamMembership) {
            throw createPolicyError('Team admin permissions are required.', 403, 'TEAM_ADMIN_REQUIRED');
        }

        return {
            ...context,
            teamMembership
        };
    }

    static async getActiveTeamMemberships(userId, organizationId) {
        if (!userId || !organizationId) {
            return [];
        }

        return TeamMember.find({
            organizationId: organizationId.toString(),
            userId: userId.toString(),
            status: 'active'
        }).lean();
    }

    static async getEffectiveSharingPolicy(userId, organizationId) {
        const { organization, membership } = await this.assertActiveMember(userId, organizationId);
        let policy = normalizeSettings(organization.settings).sharing;
        const orgSettings = normalizeSettings(organization.settings);

        if (orgSettings.allowTeamPolicyOverrides !== false) {
            const teamMemberships = await this.getActiveTeamMemberships(userId, organizationId);
            const teamIds = teamMemberships.map(teamMembership => teamMembership.teamId);
            const teams = teamIds.length
                ? await Team.find({ _id: { $in: teamIds }, organizationId: organizationId.toString(), status: 'active' }).lean()
                : [];

            teams.forEach(function(team) {
                policy = mergeRestrictiveSharingPolicy(policy, (team.settings || {}).sharing || {});
            });
        }

        policy = mergeRestrictiveSharingPolicy(policy, (membership.settings || {}).sharing || {}, { strictOnly: true });
        return policy;
    }

    static assertPermissionAllowed(policy, permission) {
        const normalizedPermission = SHARE_PERMISSIONS.includes(permission) ? permission : policy.defaultPermission;

        if (!policy.allowedPermissions.includes(normalizedPermission)) {
            throw createPolicyError(`The "${normalizedPermission}" permission is blocked by organization policy.`, 403, 'PERMISSION_BLOCKED');
        }

        return normalizedPermission;
    }

    static assertShareTargetAllowed(policy, targetType, options = {}) {
        const normalizedTargetType = targetType || 'member';

        if (normalizedTargetType === 'member' && options.external !== true && policy.memberSharingAllowed === false) {
            throw createPolicyError('Sharing with individual members is blocked by organization policy.');
        }

        if (normalizedTargetType === 'team' && policy.teamSharingAllowed === false) {
            throw createPolicyError('Sharing with teams is blocked by organization policy.');
        }

        if (normalizedTargetType === 'team' && policy.teamToTeamSharingAllowed === false && options.actorIsOrgAdmin !== true) {
            const actorTeamIds = Array.isArray(options.actorTeamIds)
                ? options.actorTeamIds.map(teamId => teamId.toString())
                : [];
            const targetTeamId = options.targetTeamId ? options.targetTeamId.toString() : null;

            if (targetTeamId && actorTeamIds.length && !actorTeamIds.includes(targetTeamId)) {
                throw createPolicyError('Team-to-team sharing is blocked by organization policy.');
            }
        }

        if (normalizedTargetType === 'organization' && policy.organizationSharingAllowed === false) {
            throw createPolicyError('Organization-wide sharing is blocked by organization policy.');
        }

        if ((normalizedTargetType === 'external' || options.external === true) && policy.externalSharingAllowed === false) {
            throw createPolicyError('External sharing is blocked by organization policy.');
        }
    }
}

module.exports = OrganizationPolicyService;
