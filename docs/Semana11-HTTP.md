# Actividad Semana 11-0: endpoints, metodos y codigos HTTP

La version M09 no tenia un servidor HTTP: ejecutaba scripts y drivers de bases
de datos directamente. Para esta actividad se agrega una API local de consulta.
No se atribuyen endpoints HTTP a las entregas anteriores.

## Ejecutar

Con las bases inicializadas mediante `make setup`:

```sh
npm run serve:http
```

Escucha solo en `127.0.0.1`, puerto 3000 o variable `HTTP_PORT`.
Ejemplo: `curl -i "http://127.0.0.1:3000/api/events?deviceId=dev_sensor_01&limit=1"`.
Detener con Ctrl+C. Las credenciales provienen del entorno local ignorado por Git.

## Rutas

| Ruta | Metodos | Funcion |
| --- | --- | --- |
| `/health` | GET, HEAD | Comprueba conectividad real a MongoDB mediante ping. |
| `/api/events` | GET, HEAD | Consulta paginada por deviceId obligatorio; from, to, cursor y limit opcionales. |
| `/api/events/{event_id}` | GET, HEAD | Lee un evento por UUID. |
| `/api/alerts` | GET, HEAD | Consulta alertas abiertas; deviceId, severity y limit opcionales. |

GET devuelve JSON. HEAD ejecuta la misma consulta y devuelve encabezados sin
cuerpo. `limit` va de 1 a 100 (20 por defecto). Se rechazan parametros desconocidos
o repetidos. La paginacion reutiliza M08. Solo se exponen campos seleccionados;
se omiten payload y datos internos. Ninguna ruta escribe en la base.

## Codigos implementados

- 200: consulta correcta; una lista vacia sigue siendo 200.
- 400: identificador o parametros invalidos. No aplica a health sin parametros.
- 404: evento inexistente o ruta desconocida.
- 405: metodo no admitido; incluye `Allow: GET, HEAD`.
- 503: fallo de conexion/configuracion MongoDB; mensaje generico, Retry-After 5.
- 500: otro fallo interno inesperado, sin revelar excepciones.

Todas las rutas admiten 200/400/405/503/500; el detalle ademas puede devolver 404.
Los 500/503 de la captura se provocan por inyeccion de una dependencia fallida en
un servidor de prueba separado. No representan una caida real de la base.
No se implementan POST, PUT, PATCH o DELETE. No se presentan 201, 401 ni 403 como
resultados obtenidos. El codigo MongoDB 13 tampoco es un codigo HTTP.

## Pruebas y capturas

```sh
npm run test:http
node scripts/capture-http.mjs
make verify
```

Las seis pruebas HTTP cubren consultas reales, HEAD, limites, vacio/ausencia,
parametros invalidos, rechazo de escrituras y fallos controlados. Se incluyen
automaticamente en la suite general. capture-http produce 18 intercambios HTTP
reales en `artifacts/semana11-http.json`, con identificacion de los fallos inyectados.
Las capturas del PDF son de un visor local de esos intercambios, no de Postman.

## Alcance y seguridad

Se usa exclusivamente la cuenta reader de M09. No hay autenticacion HTTP de
usuarios, TLS ni auditoria HTTP: es una demostracion local con fixtures sinteticos,
no una API lista para Internet. No habilitar tuneles ni acceso publico. Se mantiene
el historial y los tags anteriores, sin ampliar privilegios de MongoDB.

Implementacion: `src/http-api.mjs`; arranque: `scripts/serve-http.mjs`;
pruebas: `tests/http-api.test.mjs`; consultas reutilizadas: `src/mongo.mjs`.

Referencia: RFC 9110, secciones 9.3.1, 9.3.2, 15.3.1, 15.5.1, 15.5.5, 15.5.6,
15.6.1 y 15.6.4: https://www.rfc-editor.org/rfc/rfc9110.html
