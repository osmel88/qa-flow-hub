import type { profile as source } from '../en/profile';

export const profile: Partial<Record<keyof typeof source, string>> = {
  'profile.emailNotifications': 'Notificaciones por correo electrónico',
  'profile.masterSwitchForOptionalEmails':
    'Interruptor general de los correos opcionales. Los avisos de seguridad, como los cambios de contraseña y las invitaciones a organizaciones, se envían siempre.',
  'profile.testRunAssignments': 'Asignaciones en ejecuciones',
  'profile.whenSomeoneAssignsTestCases':
    'Cuando alguien te asigna casos de prueba en una ejecución.',
  'profile.defectAssignments': 'Asignaciones de defectos',
  'profile.whenADefectIsAssigned': 'Cuando se te asigna un defecto.',
  'profile.importantStatusChanges': 'Cambios de estado importantes',
  'profile.whenADefectYouReported':
    'Cuando un defecto que reportaste o del que eres responsable se resuelve, se cierra, se rechaza o se reabre.',
  'profile.couldNotSaveThePreference': 'No se pudo guardar la preferencia.',
  'profile.notificationPreferences': 'Preferencias de notificación',
  'profile.theseApplyToYourAccount':
    'Se aplican a tu cuenta en todas las organizaciones. Mira lo que se te envió en',
  'profile.notifications': 'Notificaciones',
  'profile.passwordChangedEverySessionWas':
    'Contraseña cambiada. Se cerraron todas las sesiones; vuelve a iniciar sesión.',
  'profile.couldNotChangeThePassword': 'No se pudo cambiar la contraseña.',
  'profile.profile': 'Perfil',
  'profile.yourAccountAndTheOrganizations': 'Tu cuenta y las organizaciones a las que perteneces.',
  'profile.account': 'Cuenta',
  'profile.name': 'Nombre',
  'profile.email': 'Correo electrónico',
  'profile.memberships': 'Organizaciones a las que perteneces',
  'profile.membershipsIntro':
    'Tu membresía en cada organización y el rol que te da en ella. El acceso por proyecto puede ampliarlo en proyectos concretos.',
  'profile.organization': 'Organización',
  'profile.organizationRole': 'Rol en la organización',
  'profile.membershipStatus': 'Estado de la membresía',
  'profile.membershipActive': 'Activa',
  'profile.membershipSuspended': 'Suspendida',
  'profile.noMemberships': 'Todavía no perteneces a ninguna organización.',
  'profile.emailHint':
    'Se usa para iniciar sesión y para las notificaciones. No se puede cambiar aquí.',
  'profile.avatar': 'Foto de perfil',
  'profile.avatarHint':
    'Se muestran tus iniciales hasta que haya una foto. Todavía no se pueden subir fotos.',
  'profile.changePassword': 'Cambiar contraseña',
  'profile.currentPassword': 'Contraseña actual',
  'profile.confirmNewPassword': 'Confirmar nueva contraseña',
  'profile.currentPasswordIsIncorrect': 'La contraseña actual no es correcta.',
  'profile.newPassword': 'Nueva contraseña',
};
