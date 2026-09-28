import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { compareMatrix } from "../src/nosql-decision.mjs";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "m04");
const readFixture = (name) => JSON.parse(fs.readFileSync(path.join(fixtureDir, name), "utf8"));

test("[M04] caso normal calcula puntajes esperados sobre 100", () => {
  const result = compareMatrix(readFixture("matrix-normal.json"));

  assert.deepEqual(result.clasificacion, [
    { puesto: 1, tipo: "column", nombre: "Store B", resultadoSobre100: 76 },
    { puesto: 2, tipo: "document", nombre: "Store A", resultadoSobre100: 72 }
  ]);
  assert.deepEqual(result.empates, []);
});

test("[M04] alternativas con mismo resultado comparten puesto y se reportan como empate", () => {
  const result = compareMatrix(readFixture("matrix-tie-zero-weight.json"));

  assert.deepEqual(result.clasificacion, [
    { puesto: 1, tipo: "document", nombre: "Empate A", resultadoSobre100: 80 },
    { puesto: 1, tipo: "graph", nombre: "Empate B", resultadoSobre100: 80 }
  ]);
  assert.deepEqual(result.empates, [{
    clasificacion: 1,
    resultadoSobre100: 80,
    alternativas: [
      { tipo: "document", nombre: "Empate A" },
      { tipo: "graph", nombre: "Empate B" }
    ]
  }]);
});

test("[M04] cambiar puntuacion de criterio con peso cero no cambia resultado", () => {
  const matrix = readFixture("matrix-tie-zero-weight.json");
  const original = compareMatrix(matrix).alternativas.map((alternative) => alternative.resultadoSobre100);

  matrix.alternativas[0].puntuaciones.criterio_inactivo.score = 5;
  matrix.alternativas[1].puntuaciones.criterio_inactivo.score = 1;
  const changed = compareMatrix(matrix).alternativas.map((alternative) => alternative.resultadoSobre100);

  assert.deepEqual(changed, original);
});

test("[M04] fallo declarado cuando los pesos no suman 100", () => {
  assert.throws(() => compareMatrix(readFixture("matrix-invalid-weight.json")), /pesos deben sumar 100/);
});

test("[M04] rechaza puntuaciones fuera del rango de 1 a 5", () => {
  const matrix = readFixture("matrix-normal.json");
  matrix.alternativas[0].puntuaciones.lectura.score = 6;

  assert.throws(() => compareMatrix(matrix), /puntuacion.*entre 1 y 5/);
});

test("[M04] rechaza justificaciones ausentes o vacias", () => {
  const matrix = readFixture("matrix-normal.json");
  delete matrix.alternativas[0].puntuaciones.lectura.hipotesis.comprobar;

  assert.throws(() => compareMatrix(matrix), /justificacion no vacia/);
});