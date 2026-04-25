const Workspace = require('../models/workspaceModel');
const Organization = require('../models/organizationModel');
const OrganizationMember = require('../models/organizationMemberModel');
const File = require('../models/fileModel');
const Folder = require('../models/folderModel');
const UploadProgress = require('../models/uplodPrgress');
const OrganizationPolicyService = require('./organizationPolicyService');

function safeId(value) {
    return value && value.toString ? value.toString() : String(value || '');
}

function sanitizeWorkspaceName(value, fallback) {
    return String(value || fallback || 'Workspace').trim() || fallback || 'Workspace';
}

class WorkspaceService {
    static serialize(workspace, extra = {}) {
        if (!workspace) {
            return null;
        }

        return {
            id: safeId(workspace._id),
            name: workspace.name,
            type: workspace.type,
            ownerUserId: workspace.ownerUserId || null,
            organizationId: workspace.organizationId || null,
            rootPath: workspace.rootPath,
            status: workspace.status,
            settings: workspace.settings || {},
            createdAt: workspace.createdAt,
            updatedAt: workspace.updatedAt,
            ...extra
        };
    }

    static async ensurePersonalWorkspace(userId) {
        const normalizedUserId = userId.toString();
        const workspace = await Workspace.findOneAndUpdate(
            {
                type: 'personal',
                ownerUserId: normalizedUserId
            },
            {
                $setOnInsert: {
                    name: 'Personal',
                    type: 'personal',
                    ownerUserId: normalizedUserId,
                    organizationId: null,
                    rootPath: normalizedUserId,
                    status: 'active'
                }
            },
            {
                upsert: true,
                new: true,
                setDefaultsOnInsert: true
            }
        );

        await this.backfillPersonalContent(normalizedUserId, workspace);
        return workspace;
    }

    static async ensureOrganizationWorkspace(organizationOrId) {
        const organization = organizationOrId && organizationOrId.name
            ? organizationOrId
            : await Organization.findById(organizationOrId).lean();

        if (!organization) {
            throw OrganizationPolicyService.createError('Organization not found.', 404, 'ORG_NOT_FOUND');
        }

        return Workspace.findOneAndUpdate(
            {
                type: 'organization',
                organizationId: safeId(organization._id)
            },
            {
                $set: {
                    name: sanitizeWorkspaceName(organization.name, 'Organization'),
                    status: organization.status === 'suspended' ? 'suspended' : 'active'
                },
                $setOnInsert: {
                    type: 'organization',
                    ownerUserId: organization.ownerUserId || null,
                    organizationId: safeId(organization._id),
                    rootPath: `organizations/${safeId(organization._id)}`
                }
            },
            {
                upsert: true,
                new: true,
                setDefaultsOnInsert: true
            }
        );
    }

    static async backfillPersonalContent(userId, workspace) {
        const workspacePatch = {
            workspaceId: safeId(workspace._id),
            workspaceType: 'personal',
            organizationId: null,
            createdByUserId: userId
        };

        await Promise.all([
            File.updateMany(
                {
                    userId,
                    $or: [
                        { workspaceId: { $exists: false } },
                        { workspaceId: null },
                        { workspaceId: '' }
                    ]
                },
                { $set: workspacePatch }
            ),
            Folder.updateMany(
                {
                    userId,
                    $or: [
                        { workspaceId: { $exists: false } },
                        { workspaceId: null },
                        { workspaceId: '' }
                    ]
                },
                { $set: workspacePatch }
            ),
            UploadProgress.updateMany(
                {
                    userId,
                    $or: [
                        { workspaceId: { $exists: false } },
                        { workspaceId: null },
                        { workspaceId: '' }
                    ]
                },
                { $set: { workspaceId: safeId(workspace._id), workspaceType: 'personal', organizationId: null } }
            ).catch(() => null)
        ]);
    }

    static async getOrganizationMembership(userId, organizationId) {
        return OrganizationMember.findOne({
            userId: userId.toString(),
            organizationId: organizationId.toString(),
            status: 'active'
        }).lean();
    }

    static async assertWorkspaceAccess(userId, workspaceId = null, options = {}) {
        const personalWorkspace = await this.ensurePersonalWorkspace(userId);
        const targetWorkspaceId = workspaceId || safeId(personalWorkspace._id);
        const workspace = await Workspace.findOne({
            _id: targetWorkspaceId
        }).lean();

        if (!workspace) {
            throw OrganizationPolicyService.createError('Workspace not found.', 404, 'WORKSPACE_NOT_FOUND');
        }

        if (workspace.status !== 'active') {
            throw OrganizationPolicyService.createError('Workspace is suspended.', 403, 'WORKSPACE_SUSPENDED');
        }

        if (workspace.type === 'personal') {
            if (workspace.ownerUserId !== userId.toString()) {
                throw OrganizationPolicyService.createError('You do not have access to this workspace.', 403, 'WORKSPACE_ACCESS_DENIED');
            }

            return {
                workspace,
                membership: null,
                canManage: true,
                canWrite: true
            };
        }

        const membership = await this.getOrganizationMembership(userId, workspace.organizationId);
        if (!membership) {
            throw OrganizationPolicyService.createError('You do not have access to this organization workspace.', 403, 'WORKSPACE_ACCESS_DENIED');
        }

        const canManage = OrganizationPolicyService.hasOrgAdminRole(membership);
        const memberWriteBlocked = membership.settings &&
            membership.settings.restrictions &&
            membership.settings.restrictions.readOnly === true;
        const canWrite = !memberWriteBlocked;

        if (options.requireWrite && !canWrite) {
            throw OrganizationPolicyService.createError('You cannot write to this workspace.', 403, 'WORKSPACE_WRITE_DENIED');
        }

        return {
            workspace,
            membership,
            canManage,
            canWrite
        };
    }

    static getWorkspacePatch(workspace, actorUserId) {
        return {
            workspaceId: safeId(workspace._id),
            workspaceType: workspace.type,
            organizationId: workspace.type === 'organization' ? workspace.organizationId : null,
            createdByUserId: actorUserId.toString()
        };
    }

    static getItemScopeQuery(workspace, extra = {}) {
        return {
            workspaceId: safeId(workspace._id),
            ...extra
        };
    }

    static async listForUser(userId) {
        const personalWorkspace = await this.ensurePersonalWorkspace(userId);
        const memberships = await OrganizationMember.find({
            userId: userId.toString(),
            status: 'active'
        }).lean();
        const organizationIds = memberships.map(membership => membership.organizationId).filter(Boolean);
        const organizations = organizationIds.length
            ? await Organization.find({ _id: { $in: organizationIds }, status: 'active' }).lean()
            : [];
        const orgById = organizations.reduce((result, organization) => {
            result[safeId(organization._id)] = organization;
            return result;
        }, {});
        const orgWorkspaces = [];

        for (const membership of memberships) {
            const organization = orgById[membership.organizationId];
            if (!organization) {
                continue;
            }

            const workspace = await this.ensureOrganizationWorkspace(organization);
            orgWorkspaces.push(this.serialize(workspace, {
                organization: {
                    id: safeId(organization._id),
                    name: organization.name,
                    slug: organization.slug
                },
                roles: membership.roles || ['member'],
                canManage: OrganizationPolicyService.hasOrgAdminRole(membership)
            }));
        }

        return [
            this.serialize(personalWorkspace, {
                label: 'Personal',
                canManage: true
            }),
            ...orgWorkspaces.sort((a, b) => a.name.localeCompare(b.name))
        ];
    }

    static async getContext(userId, workspaceId = null) {
        const workspaces = await this.listForUser(userId);
        let activeWorkspace = workspaceId
            ? workspaces.find(workspace => workspace.id === workspaceId)
            : workspaces[0];

        if (!activeWorkspace && workspaces.length) {
            activeWorkspace = workspaces[0];
        }

        if (!activeWorkspace) {
            throw OrganizationPolicyService.createError('Workspace not found.', 404, 'WORKSPACE_NOT_FOUND');
        }

        return {
            activeWorkspace,
            workspaces
        };
    }
}

module.exports = WorkspaceService;
