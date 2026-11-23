import type { releaseReadiness as source } from '../en/releaseReadiness';

export const releaseReadiness: Partial<Record<keyof typeof source, string>> = {
  'releaseReadiness.title': 'Preparación de la release',
  'releaseReadiness.description':
    'Se calcula en cada visita a partir de las puertas de calidad, ejecuciones, planes, ciclos, defectos, cobertura de requisitos, pruebas inestables y sesiones exploratorias. No se guarda nada.',
  'releaseReadiness.printable': 'Informe de preparación imprimible',
  'releaseReadiness.printTitle': 'Informe de preparación',
  'releaseReadiness.project': 'Proyecto',
  'releaseReadiness.release': 'Release',
  'releaseReadiness.generated': 'Generado',
  'releaseReadiness.computedAt': 'Calculado {date}',
  'releaseReadiness.thresholds':
    'Umbrales: al menos {minVerdicts} veredictos; tasa de fallos como máximo del {maxFailedRate}%.',
  'releaseReadiness.decisionLabel': 'Decisión',
  'releaseReadiness.decision.go': 'GO',
  'releaseReadiness.decision.go_with_risks': 'GO CON RIESGOS',
  'releaseReadiness.decision.no_go': 'NO-GO',
  'releaseReadiness.decision.insufficient_data': 'DATOS INSUFICIENTES',
  'releaseReadiness.summary.go': 'Lista para publicar: no hay bloqueos ni riesgos.',
  'releaseReadiness.summary.go_with_risks':
    'Se puede publicar asumiendo {warnings, plural, one {# riesgo} other {# riesgos}}, sin bloqueos.',
  'releaseReadiness.summary.no_go':
    'No está lista: antes hay que resolver {blockers, plural, one {# bloqueo} other {# bloqueos}}.',
  'releaseReadiness.summary.insufficient_data':
    'Todavía no hay evidencia suficiente para decidir con responsabilidad.',
  'releaseReadiness.reasons': 'Motivos',
  'releaseReadiness.blockers': 'Bloqueos',
  'releaseReadiness.warnings': 'Advertencias',
  'releaseReadiness.none': 'Ninguno.',
  'releaseReadiness.andMore': 'y {count} más',
  'releaseReadiness.source.quality_gates': 'puertas de calidad',
  'releaseReadiness.source.execution': 'ejecución de QA',
  'releaseReadiness.source.defects': 'defectos',
  'releaseReadiness.source.test_cycles': 'ciclos de prueba',
  'releaseReadiness.source.test_plans': 'planes de prueba',
  'releaseReadiness.source.requirements': 'cobertura de requisitos',
  'releaseReadiness.source.flaky': 'detección de inestables',
  'releaseReadiness.source.exploratory': 'pruebas exploratorias',
  'releaseReadiness.reason.required_gate_failed':
    '{count, plural, one {Falló # puerta de calidad obligatoria} other {Fallaron # puertas de calidad obligatorias}}.',
  'releaseReadiness.reason.critical_defects_open':
    '{count, plural, one {Sigue abierto # defecto bloqueante/crítico} other {Siguen abiertos # defectos bloqueantes/críticos}}.',
  'releaseReadiness.reason.failed_rate_above_threshold':
    'La tasa de fallos supera el umbral del {max}% ({count, plural, one {# caso fallido} other {# casos fallidos}}).',
  'releaseReadiness.reason.cycle_incomplete':
    '{count, plural, one {# ciclo de prueba de la release no está completado} other {# ciclos de prueba de la release no están completados}}.',
  'releaseReadiness.reason.high_defects_open':
    '{count, plural, one {Sigue abierto # defecto mayor} other {Siguen abiertos # defectos mayores}}.',
  'releaseReadiness.reason.defects_reopened':
    '{count, plural, one {Se reabrió # defecto} other {Se reabrieron # defectos}}.',
  'releaseReadiness.reason.flaky_tests':
    '{count, plural, one {# caso de prueba es inestable, sospechoso o falla de forma repetida} other {# casos de prueba son inestables, sospechosos o fallan de forma repetida}}.',
  'releaseReadiness.reason.requirements_uncovered':
    '{count, plural, one {# requisito no tiene casos de prueba} other {# requisitos no tienen casos de prueba}}.',
  'releaseReadiness.reason.requirements_not_executed':
    '{count, plural, one {# requisito cubierto no se ejecutó en la release} other {# requisitos cubiertos no se ejecutaron en la release}}.',
  'releaseReadiness.reason.requirements_failing':
    '{count, plural, one {# requisito tiene una prueba fallida} other {# requisitos tienen pruebas fallidas}}.',
  'releaseReadiness.reason.executions_pending':
    '{count, plural, one {# caso de prueba aún no se ha ejecutado} other {# casos de prueba aún no se han ejecutado}}.',
  'releaseReadiness.reason.tests_failed':
    '{count, plural, one {Falló # caso de prueba} other {Fallaron # casos de prueba}}.',
  'releaseReadiness.reason.tests_blocked':
    '{count, plural, one {# caso de prueba está bloqueado} other {# casos de prueba están bloqueados}}.',
  'releaseReadiness.reason.optional_gate_failed':
    '{count, plural, one {Falló # puerta de calidad opcional} other {Fallaron # puertas de calidad opcionales}}.',
  'releaseReadiness.reason.required_gate_pending':
    '{count, plural, one {# puerta de calidad obligatoria está pendiente} other {# puertas de calidad obligatorias están pendientes}}.',
  'releaseReadiness.reason.plan_incomplete':
    '{count, plural, one {# plan de prueba no está completado} other {# planes de prueba no están completados}}.',
  'releaseReadiness.reason.exploratory_incomplete':
    '{count, plural, one {# sesión exploratoria no ha terminado} other {# sesiones exploratorias no han terminado}}.',
  'releaseReadiness.reason.findings_open':
    '{count, plural, one {# hallazgo exploratorio de tipo bug no tiene defecto} other {# hallazgos exploratorios de tipo bug no tienen defecto}}.',
  'releaseReadiness.reason.not_enough_verdicts':
    'Solo hay {count, plural, one {# veredicto} other {# veredictos}}; se necesitan al menos {min}.',
  'releaseReadiness.reason.all_checks_passed':
    'Sin bloqueos ni riesgos: las puertas obligatorias pasan y todas las comprobaciones están limpias.',
  'releaseReadiness.qualityGates': 'Puertas de calidad',
  'releaseReadiness.requiredResult': 'Puertas obligatorias: {result} ({count})',
  'releaseReadiness.noGates': 'Ninguna puerta de calidad se aplica a esta release.',
  'releaseReadiness.gate': 'Puerta',
  'releaseReadiness.required': 'Obligatoria',
  'releaseReadiness.result': 'Resultado',
  'releaseReadiness.yes': 'Sí',
  'releaseReadiness.no': 'No',
  'releaseReadiness.gateResult.passed': 'Superada',
  'releaseReadiness.gateResult.failed': 'Fallida',
  'releaseReadiness.gateResult.pending': 'Pendiente',
  'releaseReadiness.gateResult.not_applicable': 'No aplica',
  'releaseReadiness.execution': 'Ejecución de QA',
  'releaseReadiness.runs': 'Ejecuciones',
  'releaseReadiness.planned': 'Planificados',
  'releaseReadiness.executed': 'Ejecutados',
  'releaseReadiness.pending': 'Pendientes',
  'releaseReadiness.passed': 'Superados',
  'releaseReadiness.failed': 'Fallidos',
  'releaseReadiness.blocked': 'Bloqueados',
  'releaseReadiness.passRate': 'Tasa de éxito',
  'releaseReadiness.failedRate': 'Tasa de fallos',
  'releaseReadiness.blockedRate': 'Tasa de bloqueos',
  'releaseReadiness.progress': 'Progreso',
  'releaseReadiness.sampleTooSmall': 'Menos de {min} veredictos: no se muestran tasas.',
  'releaseReadiness.plansCycles': 'Planes y ciclos de prueba',
  'releaseReadiness.noPlansCycles': 'Ningún plan ni ciclo de prueba apunta a esta release.',
  'releaseReadiness.kind': 'Tipo',
  'releaseReadiness.plan': 'Plan',
  'releaseReadiness.cycle': 'Ciclo',
  'releaseReadiness.name': 'Nombre',
  'releaseReadiness.status': 'Estado',
  'releaseReadiness.completion': 'Completado',
  'releaseReadiness.defects': 'Defectos',
  'releaseReadiness.openDefects': 'Abiertos',
  'releaseReadiness.reopened': 'Reabiertos',
  'releaseReadiness.requirements': 'Cobertura de requisitos',
  'releaseReadiness.totalRequirements': 'Requisitos',
  'releaseReadiness.covered': 'Cubiertos',
  'releaseReadiness.uncovered': 'Sin pruebas',
  'releaseReadiness.coveredNotExecuted': 'Cubiertos sin ejecutar',
  'releaseReadiness.failingRequirements': 'Con pruebas fallidas',
  'releaseReadiness.coverage': 'Cobertura',
  'releaseReadiness.flaky': 'Pruebas inestables',
  'releaseReadiness.flakyCount': 'Inestables',
  'releaseReadiness.suspect': 'Sospechosas',
  'releaseReadiness.failing': 'Fallando',
  'releaseReadiness.confirmed': 'Confirmadas',
  'releaseReadiness.dismissed': 'Descartadas',
  'releaseReadiness.exploratory': 'Pruebas exploratorias',
  'releaseReadiness.sessions': 'Sesiones',
  'releaseReadiness.incompleteSessions': 'Sin terminar',
  'releaseReadiness.findings': 'Hallazgos',
  'releaseReadiness.openFindings': 'Bugs sin defecto',
  'releaseReadiness.convertedFindings': 'Vinculados a un defecto',
};
