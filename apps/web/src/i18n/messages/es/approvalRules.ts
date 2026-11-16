import type { approvalRules as source } from '../en/approvalRules';

export const approvalRules: Partial<Record<keyof typeof source, string>> = {
  'approvalRules.couldNotSaveTheApproval': 'No se pudo guardar la regla de aprobación.',
  'approvalRules.approvalRules': 'Reglas de aprobación',
  'approvalRules.approvalsAReleaseNeedsProtected':
    'Aprobaciones que necesita una release; los entornos protegidos rechazan despliegues hasta que estén completas.',
  'approvalRules.addAnApprovalRule': 'Añadir una regla de aprobación',
  'approvalRules.approvalType': 'Tipo de aprobación',
  'approvalRules.approvalEnvironment': 'Entorno de la aprobación',
  'approvalRules.everyEnvironment': 'Todos los entornos',
  'approvalRules.approvalsNeeded': 'Aprobaciones necesarias',
  'approvalRules.theReleaseCreatorMayApprove': 'Quien crea la release puede aprobarla',
  'approvalRules.addApprovalRule': 'Añadir regla de aprobación',
  'approvalRules.noApprovalRuleYet': 'Todavía no hay reglas de aprobación.',
  'approvalRules.everyEnvironment2': 'todos los entornos',
  'approvalRules.selfApprovalAllowed': 'autoaprobación permitida',
  'approvalRules.delete': 'Eliminar',
  'approvalRules.rule': 'regla',
};
