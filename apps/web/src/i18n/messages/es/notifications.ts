import { BRANDING } from '../../../branding';

import type { notifications as source } from '../en/notifications';

export const notifications: Partial<Record<keyof typeof source, string>> = {
  'notifications.noMoreAutomaticRetries': '{reason} — sin más reintentos automáticos',
  'notifications.retry': '{reason} — reintento {value}',
  'notifications.mockOutbox': 'Bandeja mock',
  'notifications.developmentOnly': 'solo desarrollo',
  'notifications.messagesTheMockProviderCaptured':
    'Mensajes que el proveedor mock capturó para esta organización en lugar de enviarlos. Los enlaces con token aparecen ocultos.',
  'notifications.noCapturedEmailsYetInvite':
    'Todavía no hay emails capturados. Invita a alguien o asigna una ejecución para ver uno.',
  'notifications.notifications': 'Notificaciones',
  'notifications.everyEmailQaFlowHub': `Todos los emails que ${BRANDING.name} decidió enviarte en esta organización y qué pasó con ellos. Cambia lo que recibes en tu perfil.`,
  'notifications.emailProvider': 'Proveedor de email:',
  'notifications.nothingIsActuallyDelivered': ', en realidad no se entrega nada',
  'notifications.from': ') desde',
  'notifications.notificationPreferences': 'Preferencias de notificación',
  'notifications.filters': 'Filtros',
  'notifications.scope': 'Alcance',
  'notifications.addressedToMe': 'Dirigidas a mí',
  'notifications.wholeOrganization': 'Toda la organización',
  'notifications.type': 'Tipo',
  'notifications.allTypes': 'Todos los tipos',
  'notifications.status': 'Estado',
  'notifications.allStatuses': 'Todos los estados',
  'notifications.noNotificationsYet': 'Todavía no hay notificaciones.',
  'notifications.retryFailed': 'Reintentar fallidas',
  'notifications.when': 'Cuándo',
  'notifications.subject': 'Asunto',
  'notifications.recipient': 'Destinatario',
  'notifications.outcome': 'Resultado',
  'notifications.delivered': 'Entregada',
  'notifications.actions': 'Acciones',
  'notifications.retry2': 'Reintentar {subject}',
  'notifications.retryNow': 'Reintentar ahora',
};
