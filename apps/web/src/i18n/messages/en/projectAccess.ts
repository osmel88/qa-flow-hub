export const projectAccess = {
  'projectAccess.youCannotChangeYourOwn': 'You cannot change your own role in a project.',
  'projectAccess.anOrganizationOwnerKeepsFull':
    'An organization owner keeps full access to every project.',
  'projectAccess.yourRoleHereCannotChange':
    'Your role here ({value}) cannot change somebody who is {value2}.',
  'projectAccess.couldNotChangeTheRole': 'Could not change the role.',
  'projectAccess.couldNotRevokeTheRole': 'Could not revoke the role.',
  'projectAccess.accessTo': 'Access to {value}',
  'projectAccess.ownersAndAdminsSeeEvery':
    'Owners and admins see every project; everybody else sees it only after being given access here. A project role overrides the organization role, but only inside this project. Overrides then grant or revoke single permissions on top of that role. Whatever is shown here, the API checks the same rules on every call.',
  'projectAccess.effectiveRolesInThisProject': 'Effective roles in this project',
  'projectAccess.member': 'Member',
  'projectAccess.inTheOrganization': 'In the organization',
  'projectAccess.inThisProject': 'In this project',
  'projectAccess.enforced': 'Enforced',
  'projectAccess.permissions': 'Permissions',
  'projectAccess.change': 'Change',
  'projectAccess.noAccess': 'No access',
  'projectAccess.inherited': 'Inherited',
  'projectAccess.cannotSeeThisProject': 'Cannot see this project',
  'projectAccess.thePermissionsOf': '{value} the permissions of {email}',
  'projectAccess.hide': 'Hide',
  'projectAccess.show': 'Show',
  'projectAccess.setTheProjectRoleOf': 'Set the project role of {email}',
  'projectAccess.choose': 'Choose…',
  'projectAccess.accessWithTheirOrganizationRole': 'Access with their organization role',
  'projectAccess.revoke': 'Revoke',
  'projectAccess.removeAccess': 'Remove access',
  'projectAccess.onlyManagersChangeRoles':
    'Only members who may manage access here change project roles.',
} as const;
