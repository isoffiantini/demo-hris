# demo-hris

Demo HRIS con una pequeña UI y una API REST para gestionar empleados y jobs. Persiste los datos en `data.json`.

## Correr

```bash
npm start
```

Abrir `http://localhost:3000` para la UI. La API y la UI comparten el servidor.

## Esquema

**Employee** (campos obligatorios): `firstName`, `lastName`, `email`, `phoneNumber`, `jobId` (referencia al job).

**Job** (campos obligatorios): `name`, `description`, `department`, `status` (`open` | `closed`).

## API

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/employees` | Lista empleados (paginado por cursor) |
| GET | `/employees/:id` | Empleado por id |
| POST | `/employees` | Crea un empleado (todos los campos) |
| PATCH | `/employees/:id` | Actualiza parcial o totalmente un empleado |
| DELETE | `/employees/:id` | Elimina un empleado |
| GET | `/jobs` | Lista jobs (paginado por cursor) |
| GET | `/jobs/:id` | Job por id |
| POST | `/jobs` | Crea un job (todos los campos) |
| PATCH | `/jobs/:id` | Actualiza parcial o totalmente un job |
| DELETE | `/jobs/:id` | Elimina un job |
| GET | `/departments` | Lista departamentos únicos (paginado por cursor) |

## Paginación (cursor)

`GET /employees`, `GET /jobs` y `GET /departments` usan paginación por cursor:

- `?pageSize=N` — tamaño de página (default `10`, máximo `100`).
- `?cursor=...` — cursor opaco para la página siguiente (tomado de `next.cursor`).

`GET /employees` adicionalmente acepta `?jobId=N` para filtrar por job en el servidor.

Respuesta:

```json
{
  "data": [ ... ],
  "pageSize": 10,
  "next": { "cursor": "..." }   // null si no hay más páginas
}
```

## Health

```
GET /health
```

Respuesta: `{ "status": "ok" }` usado para validar la conexión desde Apache NiFi (InvokeHTTP).
