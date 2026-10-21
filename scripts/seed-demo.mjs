#!/usr/bin/env node
/**
 * seed-demo.mjs — Puebla el entorno DEMO con jugadores de ejemplo GENUINOS.
 *
 * La app purga los jugadores mock al arrancar y el arnés de honestidad bloquea
 * cifras sin procedencia, así que el demo NO puede "enseñar datos falsos": estos
 * jugadores llevan antropometría real → PHV/maduración se CALCULAN de verdad y
 * honestamente (Mirwald: altura/altura sentado/longitud pierna/edad/sexo).
 *
 * Se ejecuta CONTRA EL DEMO (nunca desarrollo): siembra vía la API pública, así
 * que reutiliza la validación, el dual-write y el gate de VSI del servidor.
 *
 * Uso (con las credenciales del DEMO — nunca las de producción):
 *   DEMO_API_BASE="https://vitas-demo.krujens.eu" \
 *   DEMO_SUPABASE_URL="https://<demo-ref>.supabase.co" \
 *   DEMO_SUPABASE_ANON_KEY="<anon key del demo>" \
 *   DEMO_EMAIL="demo@krujens.eu" DEMO_PASSWORD="<pass del usuario demo>" \
 *   node scripts/seed-demo.mjs
 *
 * Requisitos previos: usuario demo creado y confirmado en el Supabase del DEMO,
 * y onboarding completado (para tener perfil/rol). Ver docs/demo-setup.md.
 */

const API_BASE = process.env.DEMO_API_BASE;
const SB_URL = process.env.DEMO_SUPABASE_URL;
const SB_ANON = process.env.DEMO_SUPABASE_ANON_KEY;
const EMAIL = process.env.DEMO_EMAIL;
const PASSWORD = process.env.DEMO_PASSWORD;

for (const [k, v] of Object.entries({ DEMO_API_BASE: API_BASE, DEMO_SUPABASE_URL: SB_URL, DEMO_SUPABASE_ANON_KEY: SB_ANON, DEMO_EMAIL: EMAIL, DEMO_PASSWORD: PASSWORD })) {
  if (!v) { console.error(`✗ Falta la variable de entorno ${k}`); process.exit(1); }
}

// Salvaguarda: no sembrar por accidente contra producción.
if (/futuro-club\.vercel\.app/.test(API_BASE) || /futuro-club/.test(SB_URL)) {
  console.error("✗ DEMO_API_BASE/DEMO_SUPABASE_URL apuntan a producción. Aborta: esto es solo para el DEMO.");
  process.exit(1);
}

// altura sentado ≈ 0.52·altura; longitud pierna = altura − altura sentado.
const p = (name, age, position, foot, gender, height, weight, level) => {
  const sittingHeight = Math.round(height * 0.52);
  return {
    name, age, position, foot, gender,
    // Demo (sintético): sexo dado por elegido; sin esta marca un «M» queda «por
    // confirmar» y sin PHV (P1 bloque 7, src/lib/shared/registeredSex.ts).
    sexConfirmedAt: "2026-01-15T00:00:00.000Z",
    height, weight,
    sittingHeight,
    legLength: height - sittingHeight,
    measuredAt: "2026-09-01T10:00:00.000Z", // demo: fecha de las medidas (gate del PHV)
    competitiveLevel: level,
  };
};

// 8 jugadores de ejemplo (antropometría plausible por edad; sexo explícito).
const PLAYERS = [
  p("Lucas Herrera",   13, "CAM", "right", "M", 158, 46, "Autonómica"),
  p("Pablo Ndiaye",    15, "ST",  "left",  "M", 176, 65, "Nacional"),
  p("Mateo Rivas",     12, "CB",  "right", "M", 151, 41, "Regional"),
  p("Iker Montes",     16, "CDM", "right", "M", 179, 68, "Nacional"),
  p("Bruno Salas",     14, "RW",  "both",  "M", 164, 52, "Autonómica"),
  p("Adriana Gómez",   14, "CM",  "right", "F", 160, 50, "Autonómica"),
  p("Noa Vidal",       15, "LB",  "left",  "F", 166, 55, "Nacional"),
  p("Hugo Ferrer",     17, "GK",  "right", "M", 185, 74, "Nacional"),
];

async function signIn() {
  const res = await fetch(`${SB_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: SB_ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Login demo falló (${res.status}): ${t.slice(0, 200)}`);
  }
  const json = await res.json();
  if (!json.access_token) throw new Error("Login demo sin access_token");
  return json.access_token;
}

async function createPlayer(token, player) {
  const res = await fetch(`${API_BASE}/api/players/crud`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(player),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) {
    throw new Error(`${player.name}: ${res.status} ${json.error ?? JSON.stringify(json).slice(0, 160)}`);
  }
  return json.data ?? json;
}

(async () => {
  console.log(`→ Sembrando ${PLAYERS.length} jugadores de ejemplo en el DEMO (${API_BASE})`);
  const token = await signIn();
  let ok = 0;
  for (const player of PLAYERS) {
    try {
      await createPlayer(token, player);
      ok++;
      console.log(`  ✓ ${player.name} (${player.position}, ${player.age}a)`);
    } catch (e) {
      console.error(`  ✗ ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log(`\n✔ Hecho: ${ok}/${PLAYERS.length} jugadores creados.`);
  console.log("  PHV/maduración salen calculados (Mirwald) de la antropometría real.");
  console.log("  VSI queda 'sin evaluar' (null) hasta que el entrenador aporte métricas — honesto.");
})().catch((e) => { console.error("\n✗", e instanceof Error ? e.message : e); process.exit(1); });
