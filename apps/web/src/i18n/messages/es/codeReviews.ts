import type { codeReviews as source } from '../en/codeReviews';

export const codeReviews: Partial<Record<keyof typeof source, string>> = {
  'codeReviews.readyToMerge': 'Lista para merge',
  'codeReviews.notReadyApprovals': 'No está lista ({approvals}/{requiredApprovals} aprobaciones)',
  'codeReviews.couldNotOpenTheReview': 'No se pudo abrir la revisión.',
  'codeReviews.anyone': 'Cualquiera',
  'codeReviews.me': 'Yo',
  'codeReviews.codeReviews': 'Revisiones de código',
  'codeReviews.localCodeReviewsReviewersApprovals':
    'Revisiones de código locales: revisores, aprobaciones, peticiones de cambios y si se puede hacer merge.',
  'codeReviews.codeReviewFilters': 'Filtros de revisiones',
  'codeReviews.statusFilter': 'Filtro de estado',
  'codeReviews.anyStatus': 'Cualquier estado',
  'codeReviews.reviewerFilter': 'Filtro de revisor',
  'codeReviews.authorFilter': 'Filtro de autor',
  'codeReviews.openACodeReview': 'Abrir una revisión de código',
  'codeReviews.reviewTitle': 'Título de la revisión',
  'codeReviews.reviewer': 'Revisor',
  'codeReviews.noReviewerYet': 'Todavía sin revisor',
  'codeReviews.pullRequest': 'Pull request',
  'codeReviews.noPullRequest': 'Sin pull request',
  'codeReviews.workItem': 'Elemento de trabajo',
  'codeReviews.noWorkItem': 'Sin elemento de trabajo',
  'codeReviews.requiredApprovalsEmptyProjectRule':
    'Aprobaciones necesarias (vacío: regla del proyecto)',
  'codeReviews.openReview': 'Abrir revisión',
  'codeReviews.noCodeReviewsMatch': 'Ninguna revisión coincide.',
  'codeReviews.by': 'de',
  'codeReviews.reviewers': '· revisores:',
  'codeReviews.none': 'ninguno',
};
