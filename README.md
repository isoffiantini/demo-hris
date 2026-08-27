# demo-hris

Prueba de conectividad mínima: expone `GET /health` para validar que Apache NiFi (InvokeHTTP) puede alcanzar un endpoint público antes de construir el HRIS.

## Correr

```bash
npm start
```

## Endpoint

```
GET /health
```

Respuesta:

```json
{ "status": "ok" }
```

## Probar desde NiFi

Configurar un `InvokeHTTP` con:

- **HTTP Method**: `GET`
- **Remote URL**: `http://<host>:3000/health`

Esperado: `200` con cuerpo `{"status":"ok"}`. Si obtenés `200`, NiFi puede conectarse.
