# Contrato `vitas.maturity.v1` — estado de maduración para FICHA / Grada

Decisión del dueño **D11** (20-21 oct 2026): FICHA/Grada recibe **solo** el estado de
maduración, la fecha estimada del PHV y su confianza, **con el consentimiento del tutor** y
visible **solo para el dueño** del jugador. P2 · bloque 10.

## Petición

```
GET /api/players/maturity-export?playerId=<id>
Authorization: Bearer <JWT del dueño del jugador>
```

- Solo el dueño del jugador (`players.user_id`). No admite token de servicio.
- Menor de 18 años **o edad desconocida** ⇒ hace falta el consentimiento **activo** del
  tutor (firmado y verificado, sin retirar). Sin él no se devuelve nada del PHV.

## Respuesta 200

```json
{
  "data": {
    "schema": "vitas.maturity.v1",
    "player_id": "p1",
    "status":   { "value": "circa_phv",  "provenance": "DERIVADA", "confidence": 0.92, "units": null, "calibrated": false, "gate_reason": null, "source_ref": "…" },
    "phv_date": { "value": "2026-05-14", "provenance": "DERIVADA", "confidence": 0.92, "units": null, "calibrated": false, "gate_reason": null, "source_ref": "…" },
    "measured_at": "2026-09-01T10:00:00Z"
  }
}
```

(Valores de ejemplo, no de un jugador real.)

| Campo | Qué es |
|---|---|
| `status.value` | Fase PHV del jugador (Mirwald) **en la fecha de la medición** (`measured_at`): `pre_phv` · `circa_phv` · `post_phv`. Con una medición antigua puede no ser la fase de hoy: la tarjeta PHV de la app la recalcula con la edad de hoy y puede diferir (pendiente anotado). Comprobad `measured_at`. |
| `phv_date.value` | Fecha estimada del pico de crecimiento (fecha de nacimiento + edad del PHV), `YYYY-MM-DD`. Es una **estimación**. |
| `*.confidence` | Confianza que VITAS asigna al cálculo de Mirwald con medidas introducidas (valor fijo, 0-1). No es una probabilidad de acierto ni un intervalo de error. |
| `measured_at` | Fecha de la medición de la que sale. VITAS no fija aún una antigüedad máxima (pendiente de validar): decidid vosotros cuándo es demasiado vieja. |

Nada más: ni nombre, ni medidas, ni VSI, ni % de talla adulta.

## Errores

| HTTP | `errorDetail.code` | Cuándo |
|---|---|---|
| 400 | `invalid_params` | Falta `playerId`. |
| 403 | `forbidden` | No eres el dueño del jugador. |
| 403 | `consent_required` | Menor (o edad desconocida) sin consentimiento activo del tutor. |
| 404 | `player_not_found` | El jugador no existe. |
| 422 | `phv_unavailable` | No hay PHV fiable: faltan medidas, la medición se guardó con la edad en años enteros (anterior al cálculo con fecha de nacimiento), el sexo no está registrado o confirmado, o la medición y el cálculo no coinciden. `errorDetail.message` dice el motivo. |
| 500 | `db_error` | Fallo de la base (incluido no poder comprobar el consentimiento: falla cerrado). |

## Reglas que no cambian

- El PHV pasa por las mismas puertas que el resto de VITAS (`trustAnthroForPlayer` +
  `phvGate`, sexo registrado). Si no hay dato, se bloquea: nunca se estima.
- Las fórmulas de PHV no se tocan (invariante #4).
- Implementación: `src/lib/shared/maturityExport.ts` (constructor puro) y
  `api/players/_maturity-export.ts` (ruta).
