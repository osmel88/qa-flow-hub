import type { members as source } from '../en/members';

export const members: Partial<Record<keyof typeof source, string>> = {
  'members.youCannotChangeYourOwn':
    'No puedes cambiar tu propio rol; pídeselo a otro owner o admin.',
  'members.yourRoleCannotChangeA':
    'Tu rol ({value}) no puede cambiar a un miembro que es {value2}.',
  'members.changeRoleOf': 'Cambiar el rol de {email}',
  'members.choose': 'Elige…',
  'members.couldNotChangeThePolicy': 'No se pudo cambiar la política.',
  'members.security': 'Seguridad',
  'members.requireMultiFactorAuthentication': 'Exigir autenticación multifactor',
  'members.membersWhoseSessionDidNot':
    'Los miembros cuya sesión no pasó MFA pierden el acceso a esta organización hasta que lo configuren y vuelvan a iniciar sesión. La columna de abajo muestra quién lo tiene ya.',
  'members.couldNotSendTheInvitation': 'No se pudo enviar la invitación.',
  'members.couldNotChangeTheRole': 'No se pudo cambiar el rol.',
  'members.membersAndRoles': 'Miembros y roles',
  'members.nobodyCanGrantARole':
    'Nadie puede conceder un rol superior al suyo, y el último owner no puede perder su rol.',
  'members.inviteSomeone': 'Invitar a alguien',
  'members.email': 'Email',
  'members.thePersonDoesNotNeed': 'La persona todavía no necesita una cuenta.',
  'members.role': 'Rol',
  'members.youCanOnlyInviteSomebody': 'Solo puedes invitar a alguien de tu nivel o inferior.',
  'members.sendInvitation': 'Enviar invitación',
  'members.copyThisTokenAndPass':
    'Copia este token y pásaselo a la persona invitada. Se muestra una sola vez y no se puede recuperar.',
  'members.membersOfThisOrganization': 'Miembros de esta organización',
  'members.member': 'Miembro',
  'members.status': 'Estado',
  'members.mfa': 'MFA',
  'members.changeRole': 'Cambiar rol',
  'members.enabled': 'Activado',
  'members.off': 'Desactivado',
  'members.pendingInvitations': 'Invitaciones pendientes',
  'members.noInvitationIsPending': 'No hay invitaciones pendientes.',
  'members.revoke': 'Revocar',
};
