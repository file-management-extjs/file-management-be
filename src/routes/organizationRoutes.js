const express = require('express');
const router = express.Router();
const controller = require('../controllers/organizationController');

router.get('/context', controller.getContext);
router.post('/invitations/:membershipId/accept', controller.acceptInvitation);
router.post('/invitations/:membershipId/decline', controller.declineInvitation);
router.post('/', controller.createOrganization);

router.get('/:orgId', controller.getOrganization);
router.put('/:orgId', controller.updateOrganization);
router.get('/:orgId/overview', controller.getOverview);

router.get('/:orgId/teams', controller.listTeams);
router.post('/:orgId/teams', controller.createTeam);
router.put('/:orgId/teams/:teamId', controller.updateTeam);
router.delete('/:orgId/teams/:teamId', controller.deleteTeam);
router.get('/:orgId/teams/:teamId/members', controller.listTeamMembers);
router.post('/:orgId/teams/:teamId/members', controller.addTeamMember);
router.delete('/:orgId/teams/:teamId/members/:userId', controller.removeTeamMember);

router.get('/:orgId/members', controller.listMembers);
router.post('/:orgId/members', controller.addMember);
router.put('/:orgId/members/:memberId', controller.updateMember);
router.post('/:orgId/members/:memberId/suspend', controller.suspendMember);
router.post('/:orgId/members/:memberId/reactivate', controller.reactivateMember);
router.delete('/:orgId/members/:memberId', controller.removeMember);
router.put('/:orgId/members/:userId/teams', controller.setMemberTeams);

router.get('/:orgId/share-targets', controller.listShareTargets);
router.get('/:orgId/shares', controller.listShares);
router.post('/:orgId/policy-simulator', controller.simulatePolicy);
router.post('/:orgId/shares', controller.createShare);
router.put('/:orgId/shares/:shareId', controller.updateShare);
router.delete('/:orgId/shares/:shareId', controller.revokeShare);

router.get('/:orgId/audit', controller.listAudit);

module.exports = router;
