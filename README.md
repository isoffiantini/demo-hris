# demo-hris

Demo HRIS con una pequeña UI y una API REST para gestionar empleados y jobs. Persiste los datos en `data.json`.

## Correr

```bash
npm start
```

Abrir `http://localhost:3000` para la UI. La API y la UI comparten el servidor.

## Esquema

**Employee** (campos obligatorios): `firstName`, `lastName`, `email`, `phoneNumber`, `jobId` (referencia al job), `employmentStatus` (`Hired` | `Ex Employee`), `hireDate`. El campo `department` se deriva automáticamente del job asignado y no puede diferir del mismo.

**Job** (campos obligatorios): `name`, `description`, `departmentId` (referencia al department), `status` (`open` | `closed`), `employmentType` (`Remote` | `On-site`), `locationId` (referencia al location).

**Department**: `id`, `name`, `description` (breve descripción del área).

**Location**: `id`, `country`, `state` (ej. `Spain` / `Barcelona`).

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
| GET | `/departments` | Lista departamentos (paginado por cursor) |
| GET | `/departments/:id` | Department por id |
| POST | `/departments` | Crea un department (`name`, `description`) |
| PATCH | `/departments/:id` | Actualiza un department |
| DELETE | `/departments/:id` | Elimina un department (si no está en uso) |
| GET | `/locations` | Lista locations (paginado por cursor) |
| GET | `/locations/:id` | Location por id |
| POST | `/locations` | Crea un location (`country`, `state`) |
| PATCH | `/locations/:id` | Actualiza un location |
| DELETE | `/locations/:id` | Elimina un location (si no está en uso) |

## Paginación (cursor)

`GET /employees`, `GET /jobs`, `GET /departments` y `GET /locations` usan paginación por cursor:

- `?pageSize=N` — tamaño de página (default `10`, máximo `100`).
- `?cursor=...` — cursor opaco para la página siguiente (tomado de `next.cursor`).

`GET /employees` adicionalmente acepta `?jobId=N`, `?firstName=<texto>` (case-insensitive, substring) y `?sort=hireDate` con `?order=asc|desc` (por defecto `asc`) para filtrar/ordenar en el servidor; pueden combinarse.

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

## Integraciones

Endpoints de integración viven en `integrations/` (router `integrations/flow.js`).

### Challenge de Avature (flow_create_employee)

```
GET /flow_create_employee
```

Avature envía un header `Avature-Challenge-Code`. El endpoint responde `200` con un payload JSON que refleja el código recibido:

```json
{ "avature-challenge-code": "<valor del header>" }
```

Si no se envía el header, se devuelve el campo con valor vacío (aún `200`).

### POST /flow_create_employee

```
POST /flow_create_employee
```

Crea (o actualiza) el empleado en el HRIS y registra la ejecución del flow en la API de Junction Events.

**Input:** el payload de Avature (`{ "properties": { ... } }`) con `firstName`, `lastName`, `email`, `phone`, `job_hris_id`, y opcionalmente `recordId`.

**Headers relevantes:**
- `Avature-Tracking-Code` (o `Tracking-Code`, `X-Tracking-Code`): identifica la ejecución y se reenvía en los logs de Junction Events. Si no llega, no se envían logs.
- `Avature-Record-Id` (opcional): usado como `recordId` si no viene en el body.

**Tracking code:** Avature invoca `/flow_create_employee` directamente y el tracking code llega como query param `?externalRef=...` (equivalente a `${http.query.param.externalRef}` en NiFi). Se aceptan además estos fallbacks en este orden: query param `externalRef` → header (`Avature-Tracking-Code`, `Tracking-Code`, `X-Tracking-Code`) → body (`properties.externalRef`, `properties.trackingCode`, `externalRef`).

**Deduplicación:** si ya existe un empleado con el mismo email, se actualiza el registro existente en lugar de crear uno nuevo.

**Logs de Junction Events** (URL configurable con `JUNCTION_EVENTS_URL`): se envían dos entradas por ejecución con `recordTypeId: 2` (empleado) y `recordId` tomado de la request:

1. `INFO` — `Employee successfully created in the HRIS.` (o, si el email ya existía: `Employee email already exists - record updated.`). El `details` incluye la URL del empleado.
2. `SUCCESS` — `Flow finished successfully.` (log final).

El `dateTime` se envía con formato `yyyy-MM-dd'T'HH:mm:ss.SSS+0000` (igual que `${now():format("yyyy-MM-dd'T'HH:mm:ss.SSSZ")}` en NiFi). La respuesta es siempre `{ "asyncResponse": { "successful": true } }`, incluso si el email ya existía (en ese caso los logs lo explican sin enviar un `ERROR`).

