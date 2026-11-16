import type { organizations as source } from '../en/organizations';

export const organizations: Partial<Record<keyof typeof source, string>> = {
  'organizations.couldNotCreateTheOrganization': 'No se pudo crear la organización.',
  'organizations.couldNotAcceptTheInvitation': 'No se pudo aceptar la invitación.',
  'organizations.yourOrganizations': 'Tus organizaciones',
  'organizations.pickOneToWorkIn':
    'Elige una para trabajar, crea la tuya o únete con un token de invitación.',
  'organizations.switchOrganization': 'Cambiar de organización',
  'organizations.youDoNotBelongTo': 'Todavía no perteneces a ninguna organización.',
  'organizations.createAnOrganization': 'Crear una organización',
  'organizations.name': 'Nombre',
  'organizations.slug': 'Slug',
  'organizations.lowercaseUsedInUrlsFor': 'En minúsculas; se usa en las URL. Por ejemplo: acme-qa',
  'organizations.create': 'Crear',
  'organizations.joinWithAnInvitation': 'Unirse con una invitación',
  'organizations.invitationToken': 'Token de invitación',
  'organizations.untilEmailDeliveryExistsAn':
    'Hasta que exista el envío de emails, un admin te pasa este token directamente.',
  'organizations.join': 'Unirse',
};
