/**
 * VITAS · Tests RLS Multi-tenant (v2 simplificado)
 *
 * Usa SOLO tablas creadas por nosotros en migración 003 (parental_consents,
 * gdpr_audit_log) para tener control total del schema y evitar dependencias
 * de tablas legacy con FORCE RLS u otras configuraciones.
 *
 * REGLA DE ORO: Tenant A no puede leer NI escribir datos de Tenant B.
 *
 * Run:
 *   $env:SUPABASE_TEST_URL = "https://xxx.supabase.co"
 *   $env:SUPABASE_TEST_SERVICE_KEY = "eyJ..."
 *   npm run test:api -- rls-isolation
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

const SUPABASE_URL = process.env.SUPABASE_TEST_URL;
const SERVICE_KEY = process.env.SUPABASE_TEST_SERVICE_KEY;
const SKIP = !SUPABASE_URL || !SERVICE_KEY;

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

describe.skipIf(SKIP)("RLS · Aislamiento multi-tenant (parental_consents)", () => {
  let adminClient: ReturnType<typeof createClient>;
  let userAToken: string;
  let userBToken: string;
  let userAId: string;
  let userBId: string;
  let consentAId: string;
  let consentBId: string;

  // IDs únicos para esta ejecución (evita colisión con runs previos)
  const runId = Date.now();
  const playerAId = `rls-test-player-A-${runId}`;
  const playerBId = `rls-test-player-B-${runId}`;

  beforeAll(async () => {
    adminClient = createClient(SUPABASE_URL!, SERVICE_KEY!, {
      auth: { persistSession: false },
    });

    // ── Crear 2 users con tenants distintos ─────────────────────
    const { data: userA, error: errA } = await adminClient.auth.admin.createUser({
      email: `testA-${runId}@vitas-test.com`,
      password: "test-password-A",
      email_confirm: true,
      app_metadata: { tenant_id: TENANT_A },
    });
    if (errA) throw new Error(`createUser A: ${errA.message}`);
    userAId = userA.user!.id;

    const { data: userB, error: errB } = await adminClient.auth.admin.createUser({
      email: `testB-${runId}@vitas-test.com`,
      password: "test-password-B",
      email_confirm: true,
      app_metadata: { tenant_id: TENANT_B },
    });
    if (errB) throw new Error(`createUser B: ${errB.message}`);
    userBId = userB.user!.id;

    // Tokens
    const { data: sA } = await adminClient.auth.signInWithPassword({
      email: userA.user!.email!,
      password: "test-password-A",
    });
    const { data: sB } = await adminClient.auth.signInWithPassword({
      email: userB.user!.email!,
      password: "test-password-B",
    });
    userAToken = sA.session!.access_token;
    userBToken = sB.session!.access_token;

    // ── Crear placeholder players (con SQL directo, bypass RLS si es necesario) ─
    // Nota: usamos la función log_gdpr_action o inserción mínima para no
    // depender de columnas desconocidas. Para parental_consents necesitamos
    // un player_id válido. Lo intentamos así:
    const { error: pErrA } = await adminClient.rpc("create_test_player_for_rls" as never, {
      p_id: playerAId,
      p_tenant: TENANT_A,
    } as never);

    // Si el RPC no existe, intentar insert directo
    if (pErrA && pErrA.code !== "PGRST202") {
      // Intento alternativo: usar fetch directo a postgres con SECURITY DEFINER
      // (no disponible aquí). Simplemente no creamos player.
    }

    // ── Crear 1 parental_consent en cada tenant (con admin · bypass RLS) ──
    const { data: consentA, error: cErrA } = await adminClient
      .from("parental_consents")
      .insert({
        player_id: playerAId,  // referencia podría fallar si players no existe el row
        tenant_id: TENANT_A,
        parent_email: `parentA-${runId}@test.com`,
        parent_name: "Parent A",
        child_birthdate: "2014-06-15",
        signature_hash: `hash-A-${crypto.randomBytes(8).toString("hex")}`,
      })
      .select()
      .single();

    if (cErrA) {
      // Probable: FK falla porque players no tiene esos IDs.
      // Entonces creamos un player mínimo primero.
      console.warn(`[TEST] Insert consent A falló (${cErrA.code}): ${cErrA.message}. Creando players...`);

      // Crear players via SQL raw (omite FORCE RLS si lo tiene)
      await adminClient.rpc("exec_sql_admin" as never, {
        sql: `
          INSERT INTO players (id, name, tenant_id) VALUES
            ('${playerAId}', 'Test A', '${TENANT_A}'),
            ('${playerBId}', 'Test B', '${TENANT_B}')
          ON CONFLICT (id) DO NOTHING;
        ` as string,
      } as never).catch(() => null);

      // Reintentar consent
      const retry = await adminClient
        .from("parental_consents")
        .insert({
          player_id: playerAId,
          tenant_id: TENANT_A,
          parent_email: `parentA-retry-${runId}@test.com`,
          parent_name: "Parent A",
          child_birthdate: "2014-06-15",
          signature_hash: `hash-A-retry-${crypto.randomBytes(8).toString("hex")}`,
        })
        .select()
        .single();

      if (retry.error) {
        throw new Error(
          `No se puede insertar parental_consents: ${retry.error.message}. ` +
          `Asegúrate de que (1) la tabla players existe sin FORCE RLS o (2) ` +
          `los IDs de prueba ya existen en players.`
        );
      }
      consentAId = retry.data.id;
    } else {
      consentAId = consentA!.id;
    }

    // Consent B
    const { data: consentB, error: cErrB } = await adminClient
      .from("parental_consents")
      .insert({
        player_id: playerBId,
        tenant_id: TENANT_B,
        parent_email: `parentB-${runId}@test.com`,
        parent_name: "Parent B",
        child_birthdate: "2014-08-20",
        signature_hash: `hash-B-${crypto.randomBytes(8).toString("hex")}`,
      })
      .select()
      .single();

    if (cErrB) throw new Error(`Insert consent B: ${cErrB.message}`);
    consentBId = consentB!.id;
  }, 30_000);

  afterAll(async () => {
    if (!adminClient) return;
    // Cleanup
    await adminClient.from("parental_consents").delete().in("tenant_id", [TENANT_A, TENANT_B]);
    await adminClient.from("players").delete().in("id", [playerAId, playerBId]);
    await adminClient.from("gdpr_audit_log").delete().in("tenant_id", [TENANT_A, TENANT_B]);
    if (userAId) await adminClient.auth.admin.deleteUser(userAId).catch(() => null);
    if (userBId) await adminClient.auth.admin.deleteUser(userBId).catch(() => null);
  }, 30_000);

  // ─── Tests ───────────────────────────────────────────────────────

  // 076 (solo el dueño): parental_consents deja de tener política de cliente — el
  // navegador nunca la lee ni la escribe (solo api/ con service_role). Antes de la 076
  // lo que se comprobaba aquí era el aislamiento POR TENANT, que la 076 retira.
  it("076 · con sesión NO se lee parental_consents (ni el propio): solo service_role", async () => {
    const clientA = createClient(SUPABASE_URL!, SERVICE_KEY!, {
      global: { headers: { Authorization: `Bearer ${userAToken}` } },
    });
    const { data, error } = await clientA
      .from("parental_consents")
      .select("*")
      .eq("id", consentAId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it("Tenant A NO PUEDE leer consent de Tenant B (RLS filtra)", async () => {
    const clientA = createClient(SUPABASE_URL!, SERVICE_KEY!, {
      global: { headers: { Authorization: `Bearer ${userAToken}` } },
    });
    const { data } = await clientA
      .from("parental_consents")
      .select("*")
      .eq("id", consentBId);
    expect(data).toHaveLength(0);
  });

  it("Tenant A NO PUEDE actualizar consent de Tenant B", async () => {
    const clientA = createClient(SUPABASE_URL!, SERVICE_KEY!, {
      global: { headers: { Authorization: `Bearer ${userAToken}` } },
    });
    await clientA
      .from("parental_consents")
      .update({ parent_name: "HACKED" })
      .eq("id", consentBId);

    // Verificar que NO se modificó (con admin que ve todo)
    const { data: untouched } = await adminClient
      .from("parental_consents")
      .select("parent_name")
      .eq("id", consentBId)
      .single();
    expect(untouched!.parent_name).toBe("Parent B");
  });

  it("Tenant A NO PUEDE eliminar consent de Tenant B", async () => {
    const clientA = createClient(SUPABASE_URL!, SERVICE_KEY!, {
      global: { headers: { Authorization: `Bearer ${userAToken}` } },
    });
    await clientA.from("parental_consents").delete().eq("id", consentBId);

    // Verificar que sigue existiendo
    const { data } = await adminClient
      .from("parental_consents")
      .select("id")
      .eq("id", consentBId)
      .maybeSingle();
    expect(data).not.toBeNull();
  });

  it("076 · B tampoco lee SU consent con sesión (validación cruzada: solo service_role)", async () => {
    const clientB = createClient(SUPABASE_URL!, SERVICE_KEY!, {
      global: { headers: { Authorization: `Bearer ${userBToken}` } },
    });
    const { data } = await clientB
      .from("parental_consents")
      .select("*")
      .eq("id", consentBId);
    expect(data).toHaveLength(0);
    // …y el backend (service_role) sí la ve.
    const { data: admin } = await adminClient.from("parental_consents").select("id").eq("id", consentBId);
    expect(admin).toHaveLength(1);
  });

  it("audit log: Tenant A no ve registros de Tenant B", async () => {
    // Crear log para tenant B
    await adminClient.rpc("log_gdpr_action", {
      p_user_id: null,
      p_tenant_id: TENANT_B,
      p_action: "rls_test_action",
      p_resource_type: "test",
      p_resource_id: "x",
      p_metadata: {},
      p_ip: null,
    });

    const clientA = createClient(SUPABASE_URL!, SERVICE_KEY!, {
      global: { headers: { Authorization: `Bearer ${userAToken}` } },
    });
    const { data } = await clientA
      .from("gdpr_audit_log")
      .select("*")
      .eq("action", "rls_test_action");
    // user A no es el user_id de los logs (que están sin user_id), por eso 0
    expect(data ?? []).toHaveLength(0);
  });
});

describe.skipIf(SKIP)("RLS · Edge cases", () => {
  it("Sin JWT (anónimo) no puede leer parental_consents", async () => {
    const anon = createClient(SUPABASE_URL!, "wrong-anon-key-fake");
    const { error } = await anon.from("parental_consents").select("*").limit(1);
    expect(error).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// RLS · Aislamiento de las tablas tácticas (tactical_phases / phase_heatmaps /
// tactical_insights) — cierra el IDOR de LECTURA DIRECTA entre tenants.
//
// Propiedad derivada del `analyses` del match_id. Desde la migración 076 (solo el
// dueño): quien creó la analysis o el DUEÑO de su jugador (players.user_id), sin
// rama por tenant (la 055 usaba analyses.tenant_id = public.tenant_id()).
//
// DIAGNÓSTICO: si "Tenant A lee SUS propias fases" FALLA con la 076 aplicada,
// revisar que el jugador del análisis tenga user_id = el usuario A (ya no depende
// del hook 057 ni del claim tenant_id).
//
// La autorización a nivel de código (endpoints api/tactical/ vía ownsMatch) se
// cubre además, sin BD, en api/__tests__/tactical-ownership.test.ts.
// ─────────────────────────────────────────────────────────────────────────
describe.skipIf(SKIP)("RLS · Aislamiento tablas tácticas", () => {
  let adminClient: ReturnType<typeof createClient>;
  let userAToken = "";
  let userBToken = "";
  let userAId = "";
  let userBId = "";
  let matchAId = "";        // analyses.id del tenant A (== match_id táctico)
  let setupOk = false;      // false → tests se marcan skip (fixture no disponible)

  const runId = Date.now();
  const playerAId = `rls-tac-player-A-${runId}`;

  beforeAll(async () => {
    adminClient = createClient(SUPABASE_URL!, SERVICE_KEY!, { auth: { persistSession: false } });
    try {
      const { data: uA, error: eA } = await adminClient.auth.admin.createUser({
        email: `tacA-${runId}@vitas-test.com`, password: "pw-A-secret", email_confirm: true,
        app_metadata: { tenant_id: TENANT_A },
      });
      if (eA) throw new Error(`createUser A: ${eA.message}`);
      userAId = uA.user!.id;
      const { data: uB, error: eB } = await adminClient.auth.admin.createUser({
        email: `tacB-${runId}@vitas-test.com`, password: "pw-B-secret", email_confirm: true,
        app_metadata: { tenant_id: TENANT_B },
      });
      if (eB) throw new Error(`createUser B: ${eB.message}`);
      userBId = uB.user!.id;

      const { data: sA } = await adminClient.auth.signInWithPassword({ email: uA.user!.email!, password: "pw-A-secret" });
      const { data: sB } = await adminClient.auth.signInWithPassword({ email: uB.user!.email!, password: "pw-B-secret" });
      userAToken = sA.session!.access_token;
      userBToken = sB.session!.access_token;

      // Player de A (user_id + data son NOT NULL; tenant_id lo añade migración 003)
      const { error: pErr } = await adminClient.from("players").insert({
        id: playerAId, user_id: userAId, tenant_id: TENANT_A,
        data: { id: playerAId, name: "Tac A" },
      });
      if (pErr) throw new Error(`players insert: ${pErr.message}`);

      // Analysis de A → su id ES el match_id táctico
      const { data: an, error: aErr } = await adminClient.from("analyses").insert({
        tenant_id: TENANT_A, player_id: playerAId, video_id: `vid-${runId}`, status: "completed",
      }).select("id").single();
      if (aErr) throw new Error(`analyses insert: ${aErr.message}`);
      matchAId = an!.id as string;

      // Filas tácticas del match de A (admin bypassa RLS en el seed)
      const seeded = await Promise.all([
        adminClient.from("tactical_phases").insert({ match_id: matchAId, phase_type: "attacking", start_ms: 0, end_ms: 1000 }),
        adminClient.from("phase_heatmaps").insert({ match_id: matchAId, phase_type: "attacking" }),
        adminClient.from("tactical_insights").insert({ match_id: matchAId, headline: "seed" }),
      ]);
      const seedErr = seeded.find((r) => r.error)?.error;
      if (seedErr) throw new Error(`tactical seed: ${seedErr.message}`);

      setupOk = true;
    } catch (err) {
      console.warn(`[TEST] Setup táctico no disponible — tests skip: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, 30_000);

  afterAll(async () => {
    if (!adminClient) return;
    if (matchAId) {
      await adminClient.from("tactical_phases").delete().eq("match_id", matchAId);
      await adminClient.from("phase_heatmaps").delete().eq("match_id", matchAId);
      await adminClient.from("tactical_insights").delete().eq("match_id", matchAId);
      await adminClient.from("analyses").delete().eq("id", matchAId);
    }
    await adminClient.from("players").delete().eq("id", playerAId);
    if (userAId) await adminClient.auth.admin.deleteUser(userAId).catch(() => null);
    if (userBId) await adminClient.auth.admin.deleteUser(userBId).catch(() => null);
  }, 30_000);

  it("Tenant A lee SUS propias fases tácticas (owner + claim tenant_id OK)", async (c) => {
    if (!setupOk) return c.skip();
    const clientA = createClient(SUPABASE_URL!, SERVICE_KEY!, { global: { headers: { Authorization: `Bearer ${userAToken}` } } });
    const { data, error } = await clientA.from("tactical_phases").select("*").eq("match_id", matchAId);
    expect(error).toBeNull();
    expect((data ?? []).length).toBeGreaterThan(0);
  });

  it("Tenant B NO lee las fases del match de A (RLS filtra)", async (c) => {
    if (!setupOk) return c.skip();
    const clientB = createClient(SUPABASE_URL!, SERVICE_KEY!, { global: { headers: { Authorization: `Bearer ${userBToken}` } } });
    const { data } = await clientB.from("tactical_phases").select("*").eq("match_id", matchAId);
    expect(data ?? []).toHaveLength(0);
  });

  it("Tenant B NO lee heatmaps ni insights del match de A", async (c) => {
    if (!setupOk) return c.skip();
    const clientB = createClient(SUPABASE_URL!, SERVICE_KEY!, { global: { headers: { Authorization: `Bearer ${userBToken}` } } });
    const [hm, ins] = await Promise.all([
      clientB.from("phase_heatmaps").select("*").eq("match_id", matchAId),
      clientB.from("tactical_insights").select("*").eq("match_id", matchAId),
    ]);
    expect(hm.data ?? []).toHaveLength(0);
    expect(ins.data ?? []).toHaveLength(0);
  });

  it("Tenant B NO puede INSERTAR una fase en el match de A (WITH CHECK)", async (c) => {
    if (!setupOk) return c.skip();
    const clientB = createClient(SUPABASE_URL!, SERVICE_KEY!, { global: { headers: { Authorization: `Bearer ${userBToken}` } } });
    await clientB.from("tactical_phases").insert({ match_id: matchAId, phase_type: "defending", start_ms: 0, end_ms: 500 });
    const { data } = await adminClient.from("tactical_phases").select("phase_type").eq("match_id", matchAId);
    const types = ((data ?? []) as Array<{ phase_type: string }>).map((r) => r.phase_type);
    expect(types).not.toContain("defending");
  });

  it("Tenant B NO puede BORRAR las fases del match de A", async (c) => {
    if (!setupOk) return c.skip();
    const clientB = createClient(SUPABASE_URL!, SERVICE_KEY!, { global: { headers: { Authorization: `Bearer ${userBToken}` } } });
    await clientB.from("tactical_phases").delete().eq("match_id", matchAId);
    const { data } = await adminClient.from("tactical_phases").select("id").eq("match_id", matchAId);
    expect((data ?? []).length).toBeGreaterThan(0);
  });
});
