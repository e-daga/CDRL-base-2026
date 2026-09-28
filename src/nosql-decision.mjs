const HYPOTHESIS_FIELDS = ["supone", "comprobar", "falso_si"];
const WEIGHT_TOLERANCE = 1e-9;
const SCORE_TOLERANCE = 1e-9;

function requireText(value, location) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${location} debe incluir una justificacion no vacia.`);
  }
}

export function validateMatrix(matrix) {
  if (!matrix || typeof matrix !== "object" || Array.isArray(matrix)) {
    throw new Error("La matriz debe ser un objeto JSON.");
  }
  if (!matrix.criterios || typeof matrix.criterios !== "object" || Array.isArray(matrix.criterios)) {
    throw new Error("La matriz debe incluir criterios.");
  }

  const criteria = Object.entries(matrix.criterios);
  if (criteria.length === 0) throw new Error("La matriz debe incluir al menos un criterio.");

  let totalWeight = 0;
  for (const [criterionName, criterion] of criteria) {
    if (!criterion || typeof criterion !== "object" || Array.isArray(criterion)) {
      throw new Error(`El criterio ${criterionName} debe ser un objeto.`);
    }
    if (typeof criterion.peso !== "number" || !Number.isFinite(criterion.peso) || criterion.peso < 0 || criterion.peso > 100) {
      throw new Error(`El peso de ${criterionName} debe ser un numero entre 0 y 100.`);
    }
    requireText(criterion.justificacion, `El criterio ${criterionName}`);
    totalWeight += criterion.peso;
  }
  if (Math.abs(totalWeight - 100) > WEIGHT_TOLERANCE) {
    throw new Error(`Los pesos deben sumar 100; suman ${totalWeight}.`);
  }

  if (!Array.isArray(matrix.alternativas) || matrix.alternativas.length < 2) {
    throw new Error("La matriz debe incluir al menos dos alternativas.");
  }

  const names = new Set();
  for (const alternative of matrix.alternativas) {
    if (!alternative || typeof alternative !== "object" || Array.isArray(alternative)) {
      throw new Error("Cada alternativa debe ser un objeto.");
    }
    requireText(alternative.tipo, "Cada alternativa");
    requireText(alternative.nombre, `La alternativa ${alternative.tipo}`);
    if (names.has(alternative.nombre)) throw new Error(`Nombre de alternativa duplicado: ${alternative.nombre}.`);
    names.add(alternative.nombre);

    if (!alternative.puntuaciones || typeof alternative.puntuaciones !== "object" || Array.isArray(alternative.puntuaciones)) {
      throw new Error(`La alternativa ${alternative.nombre} debe incluir puntuaciones.`);
    }
    for (const [criterionName] of criteria) {
      const entry = alternative.puntuaciones[criterionName];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`Falta la puntuacion de ${criterionName} para ${alternative.nombre}.`);
      }
      if (typeof entry.score !== "number" || !Number.isFinite(entry.score) || entry.score < 1 || entry.score > 5) {
        throw new Error(`La puntuacion de ${criterionName} para ${alternative.nombre} debe estar entre 1 y 5.`);
      }
      if (!entry.hipotesis || typeof entry.hipotesis !== "object" || Array.isArray(entry.hipotesis)) {
        throw new Error(`Falta la justificacion de ${criterionName} para ${alternative.nombre}.`);
      }
      for (const field of HYPOTHESIS_FIELDS) {
        requireText(entry.hipotesis[field], `La hipotesis ${field} de ${criterionName} para ${alternative.nombre}`);
      }
    }
  }

  return { criteria, totalWeight };
}

function roundResult(value) {
  return Number(value.toFixed(2));
}

export function compareMatrix(matrix) {
  const { criteria } = validateMatrix(matrix);
  const alternatives = matrix.alternativas.map((alternative) => {
    let result = 0;
    const scores = {};
    for (const [criterionName, criterion] of criteria) {
      const entry = alternative.puntuaciones[criterionName];
      scores[criterionName] = {
        score: entry.score,
        hipotesis: { ...entry.hipotesis }
      };
      result += criterion.peso * entry.score / 5;
    }
    return {
      tipo: alternative.tipo,
      nombre: alternative.nombre,
      puntuaciones: scores,
      resultadoSobre100: roundResult(result),
      _resultadoPreciso: result
    };
  });

  alternatives.sort((left, right) => {
    const difference = right._resultadoPreciso - left._resultadoPreciso;
    return Math.abs(difference) <= SCORE_TOLERANCE ? left.nombre.localeCompare(right.nombre) : difference;
  });

  let rank = 0;
  let previousResult;
  for (let index = 0; index < alternatives.length; index += 1) {
    const current = alternatives[index]._resultadoPreciso;
    if (previousResult === undefined || Math.abs(current - previousResult) > SCORE_TOLERANCE) rank = index + 1;
    alternatives[index].clasificacion = rank;
    previousResult = current;
  }

  const tiedGroups = [];
  for (let index = 0; index < alternatives.length;) {
    const group = [alternatives[index]];
    let nextIndex = index + 1;
    while (nextIndex < alternatives.length && Math.abs(alternatives[nextIndex]._resultadoPreciso - group[0]._resultadoPreciso) <= SCORE_TOLERANCE) {
      group.push(alternatives[nextIndex]);
      nextIndex += 1;
    }
    if (group.length > 1) {
      tiedGroups.push({
        clasificacion: group[0].clasificacion,
        resultadoSobre100: group[0].resultadoSobre100,
        alternativas: group.map(({ tipo, nombre }) => ({ tipo, nombre }))
      });
    }
    index = nextIndex;
  }

  return {
    version: matrix.version,
    formula: "suma(peso * puntuacion / 5), resultado sobre 100",
    escala: matrix.escala,
    criterios: Object.fromEntries(criteria.map(([name, criterion]) => [name, {
      peso: criterion.peso,
      justificacion: criterion.justificacion
    }])),
    alternativas: alternatives.map(({ _resultadoPreciso, ...alternative }) => alternative),
    clasificacion: alternatives.map(({ tipo, nombre, resultadoSobre100, clasificacion }) => ({
      puesto: clasificacion,
      tipo,
      nombre,
      resultadoSobre100
    })),
    empates: tiedGroups
  };
}