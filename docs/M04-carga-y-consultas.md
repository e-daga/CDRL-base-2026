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