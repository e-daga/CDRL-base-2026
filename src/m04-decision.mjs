import { compareMatrix } from "./nosql-decision.mjs";

const types = ["column", "document", "graph", "object"];
const criteria = ["consultas", "consistencia", "costo", "escala", "fallos"].sort();

export function buildM04Report(matrix) {
  const comparison = compareMatrix(matrix);
  if (JSON.stringify(matrix.alternativas.map((item) => item.tipo).sort()) !== JSON.stringify(types)) {
    throw new Error("M04 requiere exactamente document, graph, column y object.");
  }
  if (JSON.stringify(Object.keys(matrix.criterios).sort()) !== JSON.stringify(criteria)) {
    throw new Error("M04 requiere consultas, escala, consistencia, costo y fallos.");
  }
  const assumptions = matrix.supuestos;
  const fields = ["dispositivos", "eventosPorDispositivoMinuto", "bytesPorEvento", "retencionDias", "diasMes",
    "consultasPorSegundo", "limiteConsulta", "p95LecturaMs", "p95EscrituraMs", "recuperacionNodoSegundos", "presupuestoMensualUSD"];
  for (const key of fields) {
    if (!Number.isFinite(assumptions?.[key]) || assumptions[key] <= 0) throw new Error(`Supuesto invalido: ${key}`);
  }
  if (!(assumptions.disponibilidadObjetivo > 0 && assumptions.disponibilidadObjetivo <= 1)) {
    throw new Error("Supuesto invalido: disponibilidadObjetivo");
  }
  for (const key of ["region", "fechaReferencia", "naturaleza"]) {
    if (typeof assumptions[key] !== "string" || !assumptions[key].trim()) throw new Error(`Falta supuesto: ${key}`);
  }
  for (const alternative of matrix.alternativas) {
    for (const entry of Object.values(alternative.puntuaciones)) {
      if (entry.estado !== "hipotesis_no_medida") throw new Error("M04 no dispone de mediciones de motores; declarar hipotesis_no_medida.");
      if (!Array.isArray(entry.fuentes) || entry.fuentes.length === 0) throw new Error("Faltan fuentes de contexto.");
      for (const source of entry.fuentes) {
        let url;
        try { url = new URL(source); } catch { throw new Error("Fuente invalida."); }
        if (url.protocol !== "https:" || url.username || url.password) throw new Error("Fuente debe ser HTTPS sin credenciales.");
      }
    }
  }
  const eventsPerDay = assumptions.dispositivos * assumptions.eventosPorDispositivoMinuto * 1440;
  const workload = {
    eventsPerSecond: eventsPerDay / 86400,
    eventsPerDay,
    eventsPerMonth: eventsPerDay * assumptions.diasMes,
    retainedEvents: eventsPerDay * assumptions.retencionDias,
    logicalGBPerDay: eventsPerDay * assumptions.bytesPorEvento / 1e9,
    logicalGBRetained: eventsPerDay * assumptions.bytesPorEvento * assumptions.retencionDias / 1e9,
    applicationQueriesPerMonth: assumptions.consultasPorSegundo * 86400 * assumptions.diasMes,
    physicalStorageMeasured: false
  };
  if (Object.values(workload).some((value) => typeof value === "number" && !Number.isFinite(value))) {
    throw new Error("El volumen calculado no es finito.");
  }
  // A small priority change tests whether the decision is robust, without changing scores.
  const sensitivityMatrix = structuredClone(matrix);
  const transferredWeight = Math.min(10, matrix.criterios.consultas.peso);
  sensitivityMatrix.criterios.consultas.peso -= transferredWeight;
  sensitivityMatrix.criterios.escala.peso += transferredWeight;
  const sensitivity = compareMatrix(sensitivityMatrix);
  const winners = comparison.clasificacion.filter((item) => item.puesto === 1);
  return {
    assignmentId: "m04-nosql-decision",
    status: "passed",
    scope: "Matrix validation, weighted arithmetic and sensitivity; not a database benchmark.",
    measurements: { nosqlEnginesExecuted: false, cloudDeployed: false, pricesQuoted: false },
    comparison,
    assumptions,
    workload,
    decision: { status: winners.length === 1 ? "conditional" : "requires-review", selected: winners.length === 1 ? winners[0] : null, winners },
    sensitivity: {
      scenario: "Transferir peso de consultas a escala, conservando las puntuaciones.",
      transferredWeight,
      ranking: sensitivity.clasificacion,
      winnerChanges: comparison.clasificacion[0].tipo !== sensitivity.clasificacion[0].tipo
    }
  };
}
