// Remy — backend mínimo y lógico (v1)
// - Sin dependencias de OpenAI (solo regex + OSM)
// - Flujo: saluda una vez → pide ciudad → pide antojo → recomienda 2–3 opciones
// - Responde en el idioma del usuario
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

/* -------------------- Sesiones muy simples -------------------- */
const SESS = new Map();
function sess(id) {
  if (!SESS.has(id)) {
    SESS.set(id, { lang: "es", city: "", zone: "", cuisine: "", budget: "", greeted: false, lastAt: 0 });
  }
  return SESS.get(id);
}
function resetSession(id) {
  SESS.set(id, { lang: "es", city: "", zone: "", cuisine: "", budget: "", greeted: false, lastAt: 0 });
}

/* -------------------- Utilidades -------------------- */
function detectLang(t = "") {
  const s = (t || "").toLowerCase();
  if (/[áéíóúñü¿¡]/.test(s)) return "es";
  if (/(hola|buenas|ciudad|zona|antojo|presupuesto|cdmx|méxico|mexico)/i.test(s)) return "es";
  return "en";
}
const RE = {
  greet: /\b(hola|buenas|hello|hi|hey)\b/i,
  reset: /(olvida|reinicia|empecemos de nuevo|borra|reset|start over)/i,
  city1: /\b(?:estoy|ahora)\s+en\s+([a-záéíóúüñ .'-]+)$/i,
  city2: /^\s*en\s+([a-záéíóúüñ .'-]+)\s*$/i,
  city3: /\bin\s+([a-z .'-]+)\b/i,
  zone: /(zona|colonia|barrio|neighbou?rhood|área)\s+(de\s+)?([a-záéíóúüñ .'-]+)$/i,
  budget: /\$?\s?(\d{2,6})\s*(mxn|pesos|usd)?/i,
};
function pickCuisine(msg = "") {
  const map = [
    [/ramen|noodle/i, "ramen"],
    [/sushi|omakase|izakaya/i, "sushi"],
    [/pizza|trattoria|pasta|italian|italiana|osteria/i, "italiana"],
    [/tacos?|pastor|birria|barbacoa|taquer/i, "tacos"],
    [/veg(etari[ao]|an)|vegan/i, "vegetariana"],
    [/mariscos?|sea ?food/i, "mariscos"],
    [/burger|hamburg/i, "hamburguesa"],
    [/mexican(a|o)|antojitos/i, "mexicana"],
    [/japones(a)?/i, "japonesa"],
  ];
  for (const [r, v] of map) if (r.test(msg)) return v;
  const m = msg.match(/(?:tengo\s+antojo\s+de|se\s+me\s+antoja|quiero|craving|i\s*want)\s+([a-záéíóúüñ .'-]+)/i);
  return m ? m[1].trim() : "";
}
function extractSlots(msg = "", s) {
  // ciudad
  let city = "";
  const m = msg.match(RE.city1) || msg.match(RE.city2) || null;
  if (m) city = m[1].trim();
  else {
    const m3 = msg.match(RE.city3);
    if (m3 && m3[1].length < 40) city = m3[1].trim();
  }
  // zona
  let zone = "";
  const z = msg.match(RE.zone);
  if (z) zone = (z[3] || "").trim();
  // antojo
  const cuisine = pickCuisine(msg);
  // presupuesto
  const b = msg.match(RE.budget);
  const budget = b ? b[1] : "";

  return {
    city: city || s.city,
    zone: zone || s.zone,
    cuisine: cuisine || s.cuisine,
    budget: budget || s.budget,
  };
}
function t(lang, key, vars = {}) {
  const es = {
    greet: "¡Hola! Soy Remy 👋 chef y cazador de buenos lugares. ¿En qué ciudad estás y qué se te antoja?",
    ask_city: "Para ayudarte, dime en qué ciudad estás.",
    ask_cuisine: (c) => `Perfecto, ${c}. ¿Qué se te antoja hoy? (ej. sushi, tacos, pizza, ramen)`,
    ask_zone: "¿Alguna zona/colonia preferida?",
    ask_budget: "¿Tienes un presupuesto aproximado por persona?",
    refine: (c, cu) => `Para darte algo top en ${c}${cu ? ` para ${cu}` : ""}, dime una zona (p. ej. Roma/Condesa/Polanco) o ajusta el antojo.`,
    list_head: (ctx) => `Te dejo opciones${ctx ? ` en ${ctx}` : ""}:`,
    error_geo: (c, z) => `No ubico bien ${z ? `${z}, ` : ""}${c}. ¿Qué colonia te queda cómodo?`,
    reset_ok: "Listo, reinicié la conversación. ¿En qué ciudad estás y qué se te antoja?",
    hiccup: "Tuve un detalle técnico. Intentemos de nuevo.",
  };
  const en = {
    greet: "Hey! I'm Remy 👋 a chef-y guide to great spots. Which city are you in and what are you craving?",
    ask_city: "To help you, tell me which city you're in.",
    ask_cuisine: (c) => `Great, ${c}. What are you craving today? (e.g., sushi, tacos, pizza, ramen)`,
    ask_zone: "Any preferred neighborhood?",
    ask_budget: "Do you have an approximate budget per person?",
    refine: (c, cu) => `To land something great in ${c}${cu ? ` for ${cu}` : ""}, give me a neighborhood or tweak the craving.`,
    list_head: (ctx) => `Here are some options${ctx ? ` in ${ctx}` : ""}:`,
    error_geo: (c, z) => `I couldn't place ${z ? `${z}, ` : ""}${c}. Which neighborhood works?`,
    reset_ok: "Done. I reset our chat. Which city are you in and what are you craving?",
    hiccup: "I hit a hiccup. Let's try again.",
  };
  const pack = lang === "es" ? es : en;
  const v = pack[key];
  return typeof v === "function" ? v(...[].concat(vars)) : v;
}

/* -------------------- OSM (Nominatim + Overpass) -------------------- */
const NOMINATIM_EMAIL = process.env.NOMINATIM_EMAIL || "remy@example.com";
const UA = `Remy-Min/${NOMINATIM_EMAIL}`;
async function geocode(q) {
  const u = new URL("https://nominatim.openstreetmap.org/search");
  u.searchParams.set("q", q);
  u.searchParams.set("format", "jsonv2");
  u.searchParams.set("addressdetails", "1");
  u.searchParams.set("limit", "1");
  u.searchParams.set("email", NOMINATIM_EMAIL);
  const r = await fetch(u, { headers: { "User-Agent": UA } });
  if (!r.ok) return null;
  const arr = await r.json();
  return arr?.[0] || null;
}
async function geoCityZone(city, zone) {
  const g = await geocode(zone ? `${zone}, ${city}` : city);
  return g && g.lat && g.lon ? g : null;
}
const CHAIN = [
  /vips/i, /sanborns/i, /toks/i, /ihop/i, /subway/i, /kfc/i, /burger\s*king/i,
  /domino/i, /little\s*caesars/i, /papa\s*john/i, /pizza\s*hutm?/i, /potzolcalli/i
];
function goodPlace(e, wantFastFood) {
  const n = (e.tags?.name || "").toLowerCase();
  if (!n) return false;
  if (CHAIN.some((re) => re.test(n))) return false;
  if (!wantFastFood && e.tags?.amenity === "fast_food") return false;
  return true;
}
function toCard(e) {
  const t = e.tags || {};
  const addr = [
    (t["addr:street"] || "") + (t["addr:housenumber"] ? ` ${t["addr:housenumber"]}` : ""),
    t["addr:suburb"] || t["addr:neighbourhood"] || "",
    t["addr:city"] || "",
  ].filter(Boolean).join(", ");
  return { name: t.name || "", cuisines: (t.cuisine || "").split(";").map(s=>s.trim()).filter(Boolean), address: addr };
}
async function overpassSearch(lat, lon, cuisine = "", radius = 3000) {
  const wantFast = /(taco|pastor|birria|barbacoa|street\s*food)/i.test(cuisine);
  const nameRe =
    /ramen/i.test(cuisine) ? "(ramen|noodle|izakaya|japanese)" :
    /sushi|omakase|izakaya/i.test(cuisine) ? "(sushi|izakaya|omakase)" :
    /pizza|italian|italiana|trattoria|pasta|osteria/i.test(cuisine) ? "(pizza|trattoria|italian|pasta|osteria)" :
    /taco|pastor|birria|barbacoa|taquer/i.test(cuisine) ? "(taco|taquer|pastor|birria|barbacoa)" :
    "";
  const around = `around:${Math.max(800, Math.min(5000, radius))},${lat},${lon}`;
  const data = `
[out:json][timeout:25];
(
  node["amenity"~"^(restaurant${wantFast?"|fast_food":""}|cafe)$"]${nameRe ? `["name"~"${nameRe}",i]`:""}(${around});
  way ["amenity"~"^(restaurant${wantFast?"|fast_food":""}|cafe)$"]${nameRe ? `["name"~"${nameRe}",i]`:""}(${around});
  relation["amenity"~"^(restaurant${wantFast?"|fast_food":""}|cafe)$"]${nameRe ? `["name"~"${nameRe}",i]`:""}(${around});
);
out center tags 80;`;
  const r = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
    body: new URLSearchParams({ data }).toString(),
  });
  if (!r.ok) return [];
  const j = await r.json();
  const arr = (j?.elements || []).filter((e) => goodPlace(e, wantFast)).map(toCard);

  // puntaje chiquito: nombre + match cocina + dirección
  return arr.map(p => {
    let s = 0;
    if (p.name) s += 2;
    if (p.cuisines.length) s += 1;
    if (p.address) s += 1;
    if (nameRe && new RegExp(nameRe, "i").test(p.name)) s += 2;
    return { ...p, _score: s };
  }).sort((a,b)=>b._score-a._score).slice(0,3);
}

/* -------------------- Respuestas -------------------- */
function listText(lang, items, ctx) {
  const head = t(lang, "list_head", [ctx]);
  const body = items.map(p=>{
    const cs = p.cuisines?.length ? ` (${p.cuisines.slice(0,2).join(", ")})` : "";
    const ad = p.address ? ` — ${p.address}` : "";
    return `• ${p.name}${cs}${ad}`;
  }).join("\n");
  return `${head}\n${body}`;
}

/* -------------------- API -------------------- */
app.get("/", (_, res)=>res.send("remy-min 1.0"));

app.post("/recommendation", async (req, res) => {
  try {
    const { message = "", manychat_user_id = "", city="", cuisine="", zone="", budget="" } = req.body || {};
    if (!manychat_user_id) return res.status(400).json({ error: "manychat_user_id is required" });

    const S = sess(manychat_user_id);
    // idioma por último mensaje
    S.lang = detectLang(message) || S.lang;

    // reset
    if (RE.reset.test(message)) {
      resetSession(manychat_user_id);
      const S2 = sess(manychat_user_id);
      return res.json({ reply: t(S2.lang,"reset_ok"), followup: t(S2.lang,"ask_city"), slots: { city:"", zone:"", cuisine:"", budget:"" }, next_slot: "city" });
    }

    // actualizar slots por body + mensaje
    Object.assign(S, { city: city || S.city, cuisine: cuisine || S.cuisine, zone: zone || S.zone, budget: budget || S.budget });
    Object.assign(S, extractSlots(message, S));
    S.lastAt = Date.now();

    // saludo: solo si no está saludado y no hay ciudad/antojo
    if (!S.greeted && RE.greet.test(message)) {
      S.greeted = true;
      return res.json({ reply: t(S.lang,"greet"), followup: t(S.lang,"ask_city"), slots: { city:S.city, zone:S.zone, cuisine:S.cuisine, budget:S.budget }, next_slot: "city" });
    }

    // pedir ciudad
    if (!S.city) {
      return res.json({ reply: t(S.lang,"ask_city"), followup: t(S.lang,"ask_city"), slots: { city:"", zone:S.zone, cuisine:S.cuisine, budget:S.budget }, next_slot: "city" });
    }

    // pedir antojo
    if (!S.cuisine) {
      return res.json({ reply: t(S.lang,"ask_cuisine",[S.city]), followup: t(S.lang,"ask_cuisine",[S.city]), slots: { city:S.city, zone:S.zone, cuisine:"", budget:S.budget }, next_slot: "cuisine" });
    }

    // geocodificar
    const pin = await geoCityZone(S.city, S.zone);
    if (!pin) {
      return res.json({ reply: t(S.lang,"error_geo",[S.city, S.zone]), followup: t(S.lang,"ask_zone"), slots: { city:S.city, zone:S.zone, cuisine:S.cuisine, budget:S.budget }, next_slot: "zone" });
    }

    const lat = parseFloat(pin.lat), lon = parseFloat(pin.lon);
    let items = await overpassSearch(lat, lon, S.cuisine, S.zone ? 1500 : 3000);

    if (!items.length) {
      return res.json({ reply: t(S.lang,"refine",[S.city, S.cuisine]), followup: t(S.lang,"ask_zone"), slots: { city:S.city, zone:S.zone, cuisine:S.cuisine, budget:S.budget }, next_slot: "zone" });
    }

    const ctx = [S.city, S.zone].filter(Boolean).join(", ");
    const follow = S.budget ? "" : t(S.lang,"ask_budget");

    return res.json({
      reply: listText(S.lang, items, ctx),
      followup: follow,
      slots: { city:S.city, zone:S.zone, cuisine:S.cuisine, budget:S.budget },
      next_slot: follow ? "budget" : ""
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ reply: "Ups, algo pasó. Intentemos otra vez.", followup: "", error: "internal_error" });
  }
});

/* -------------------- Start -------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Remy-min listening on :" + PORT));

