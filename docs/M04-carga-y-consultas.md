# M04 - Carga y consultas de CDRL

## Consultas principales
1. **Eventos por dispositivo**: dado un `device_id` y un rango de tiempo, devolver eventos ordenados por fecha.
2. **Alertas abiertas**: listar alertas con `status = open`, filtrables por dispositivo y severidad.

## Datos conocidos
- El contrato de datos (campos y formato del evento) viene de M01-M03 y está en el repositorio (`db/` y `docs/`). Esta matriz no lo modifica.

## Supuestos (a validar)
| Variable | Valor supuesto | Cómo validarlo |
|---|---|---|
| Dispositivos | 100 | Confirmar con el equipo |
| Eventos/dispositivo/min | 6 | Medir en datos de prueba |
| Tamaño por evento | 1 KB | Medir un JSON real |
| Retención | 90 días | Confirmar con el asesor |
| Alertas abiertas simultáneas | 500 | Estimar con datos de M03 |

## Volumen derivado
`eventos/día = dispositivos x eventos/min x 1440`
`GB/día = eventos/día x KB por evento / 1e6`
`Almacenamiento total = GB/día x retención`

## Volumen calculado con los supuestos
- Eventos/día: 100 x 6 x 1440 = 864,000
- GB/día: 864,000 x 1 KB / 1e6 = 0.864
- Almacenamiento a 90 días: 77.76 GB

## Precision del escenario para el cierre

La fuente ejecutable de estos supuestos es `m04-nosql-matrix.json`, campo
`supuestos`. KB y GB son decimales (1000 y 1e9 bytes). Los 77.76 GB son
logicos, sin indices, replicas, backups, proyecciones ni compresion.

El escenario equivale a 10 eventos/s y 25.92 millones de eventos por mes de
30 dias. Se supone 1 consulta/s (2.592 millones/mes), con limite de 100 filas,
p95 de lectura/escritura de 100 ms y disponibilidad objetivo 99.9%.
Se propone evaluar recuperacion de un nodo en 30 s y un presupuesto de
1000 USD/mes en us-east-1. Son umbrales hipoteticos, no acuerdos de gasto,
precios cotizados ni mediciones. Cada celda de la matriz dice como refutarse.

Q1/Q2 son requisitos arquitectonicos: el codigo M02 actual filtra por
dispositivo y limita/ordena eventos; rango temporal y filtro de severidad
se proponen para M04, no se presentan como funciones ya implementadas.

La comparacion S3 de un evento por objeto requiere 25.92M PUT/mes, mas los
GET/LIST de cada consulta. Los lotes requieren declarar cuantos eventos
contienen y recalcular latencia y operaciones. No se mantiene la estimacion
inicial de 5M requests porque no representaba el mismo workload.
