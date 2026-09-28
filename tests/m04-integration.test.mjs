import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { buildM04Report } from "../src/m04-decision.mjs";

const matrix = () => JSON.parse(fs.readFileSync(new URL("../docs/m04-nosql-matrix.json", import.meta.url), "utf8"));

test("[M04][normal] matriz real calcula ranking y volumen revisados a mano", () => {
  const report = buildM04Report(matrix());
  assert.deepEqual(report.comparison.clasificacion.map((item) => [item.tipo, item.resultadoSobre100]),
    [["document", 83], ["column", 80], ["object", 72], ["graph", 51]]);
  assert.equal(report.workload.eventsPerDay, 864000);
  assert.equal(report.workload.eventsPerMonth, 25920000);
  assert.equal(report.workload.logicalGBRetained, 77.76);
  assert.equal(report.workload.applicationQueriesPerMonth, 2592000);
  assert.equal(report.decision.selected.tipo, "document");
  assert.equal(report.measurements.nosqlEnginesExecuted, false);
});

test("[M04][boundary] mayor prioridad a escala cambia el candidato preferido", () => {
  const report = buildM04Report(matrix());
  assert.equal(report.sensitivity.winnerChanges, true);
  assert.equal(report.sensitivity.ranking[0].tipo, "column");
  assert.equal(report.sensitivity.ranking[0].resultadoSobre100, 82);
});

test("[M04][boundary] empate no se resuelve inventando un ganador", () => {
  const input = matrix();
  input.criterios.consultas.peso = 22.5;
  input.criterios.escala.peso = 27.5;
  const report = buildM04Report(input);
  assert.equal(report.decision.status, "requires-review");
  assert.equal(report.decision.selected, null);
  assert.equal(report.decision.winners.length, 2);
  assert.equal(report.decision.winners[0].resultadoSobre100, 81.5);
});

test("[M04][declared failure] rechaza familia omitida o duplicada", () => {
  const input = matrix();
  input.alternativas.pop();
  assert.throws(() => buildM04Report(input), /exactamente/);
  const duplicate = matrix();
  duplicate.alternativas[3].tipo = "document";
  assert.throws(() => buildM04Report(duplicate), /exactamente/);
});

test("[M04][declared failure] rechaza volumen invalido", () => {
  const input = matrix();
  input.supuestos.retencionDias = 0;
  assert.throws(() => buildM04Report(input), /Supuesto invalido/);
});

test("[M04][declared failure] rechaza fuentes ausentes y protocolos inseguros", () => {
  const input = matrix();
  input.alternativas[0].puntuaciones.consultas.fuentes = [];
  assert.throws(() => buildM04Report(input), /Faltan fuentes/);
  input.alternativas[0].puntuaciones.consultas.fuentes = ["http://example.invalid"];
  assert.throws(() => buildM04Report(input), /HTTPS/);
});

test("[M04][declared failure] no etiqueta hipotesis como mediciones realizadas", () => {
  const input = matrix();
  input.alternativas[0].puntuaciones.consultas.estado = "medido";
  assert.throws(() => buildM04Report(input), /no dispone de mediciones/);
});

test("[M04][normal] resultado conserva las veinte hipotesis y sus fuentes", () => {
  const report = buildM04Report(matrix());
  const entries = report.comparison.alternativas.flatMap((item) => Object.values(item.puntuaciones));
  assert.equal(entries.length, 20);
  assert.ok(entries.every((item) => item.fuentes.length && item.hipotesis.falso_si && item.estado === "hipotesis_no_medida"));
});
