import { createApi } from "../src/http-api.mjs";

const port = Number(process.env.HTTP_PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("HTTP_PORT invalido.");
const server = createApi();
server.on("error", () => { console.error("No se pudo abrir la API local; comprobar HTTP_PORT."); process.exitCode = 1; });
server.listen(port, "127.0.0.1", () => console.log(`API local CDRL: http://127.0.0.1:${port} (GET/HEAD, solo lectura)`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close());
