// Remy Backend v3.3 – saludo amable, idioma consistente, NLU robusto y sugerencias sin fricción
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { OpenAI } from "openai";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const BUILD = "3.3.0";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --------- Sesiones en memoria ---------
const SESS = new Map();
function getS(id) {
  if (!SESS.has(id)) {
    SESS.set(id, {
      lang: "es",
      slots: { city: "", zone: "", cuisine: "", budget: "" },
      lastAsked: "",
      lastMsgAt: Date.now(),
    });
  }
  return SESS.get(id);
}
function saveSlots(id, upd = {}) {
  const s = getS(id);
  const norm = (v) => (typeof v === "string" ? v.trim() : v || "");
  const merged = { ...s.slots, ...upd };
  if (merged.budget) {
    const m = String(merged.budget).match(/\d{2,6}/);
    merged.budget = m ? m[0] : "";
  }
  s.slots = {
    city: norm(merged.city),
    zone: norm(merged.zone),
    cuisine: norm(merged.cuisine),
    budget: norm(merged.budget),
  };
  s.lastMsgAt = Date.now();
  return s.slots;
}
function resetS(id) {
  const s = getS(id);
  s.slots = { city: "", zone: "", cuisine: "", budget: "" };
  s.lastAsked = "";
  s.lastMsgAt = Date.now();
}

// --------- Idioma ---------
function guessLang(text = "") {
  const t = text.toLowerCase();
  if (/[áéíóúñü¿¡]/.test(t)) return "es";
  if (/(hola|estoy|ciudad|zona|presupuesto|antojo|quiero|cdmx|méxico|mexico)/i.test(t)) return "es";
  return "en";
}
function keepLang(message, current = "es") {
  const g = guessLang(message);
  return g || current;
}

// --------- Detectores rápidos (regex) ---------
const HELLO_RE = /\b(hola|qué onda|buenas|hello|hi|hey)\b/i;
const RESET_RE = /(olvida|reinicia|empecemos de nuevo|reset)/i;

function rxCity(msg) {
  // “estoy en X”, “en X”, “ahora en X”
  const m =
    msg.match(/\b(?:estoy|ahora)\s+en\s+([a-záéíóúüñ .'-]+)$/i) ||
    msg.match(/^\s*en\s+([a-záéíóúüñ .'-]+)\s*$/i);
  return m ? m[1].trim() : "";
}

function rxCuisine(msg) {
  const map = [
    { re: /(ramen|noodle)/i, v: "ramen" },
    { re: /(sushi|omakase|izakaya)/i, v: "sushi" },
    { re: /(pizza|trattoria|pasta|italian|italiana|osteria)/i, v: "italiana" },
    { re: /(tacos?|pastor|birria|barbacoa|taquer)/i, v: "tacos" },
    { re: /(veg(etari[ao]|an))/i, v: "vegetariana" },
    { re: /(burg(er|uesa)|hamburg)/i, v: "hamburguesa" },
    { re: /(mariscos?|sea ?food)/i, v: "mariscos" },
  ];
  for (const e of map) if (e.re.test(msg)) return e.v;
  // frases “tengo antojo de … / se me antoja … / quiero …”
  const m = msg.match(/(?:tengo\s+antojo\s+de|se\s+me\s+antoja|quiero)\s+([a-záéíóúüñ .'-]+)/i);
  return m ? m[1].trim() : "";
}

function rxBudget(msg) {
  const m = msg.match(/\$?\s?(\d{2,5})\s*(mxn|pesos|usd)?/i);
  return m ? m[1] : "";
}

// --------- NLU (LLM + regex respaldo) ---------
async function extractNLU(message, prev) {
  const sys = `Devuelve SOLO JSON exacto:
{
  "updates": { "city": "", "zone": "", "cuisine": "", "budget": "" },
  "intent": "recommend|update|reset|chitchat|why|unknown"
}
Reglas:
- "olvida/reinicia/empecemos de nuevo" => intent=reset.
- Si dice "hola/hello/hi/hey" => intent=chitchat (no pidas info todavía).
- "estoy en/ahora en/en X" => updates.city.
- "zona/por la zona de/en la colonia X" => updates.zone.
- "tengo antojo de/quiero/se me antoja X" => updates.cuisine.
- Presupuesto "$300/300 pesos" => updates.budget (solo número).`;

  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: `msg: """${message}"""\nprev: ${JSON.stringify(prev)}` },
      ],
    });
    const txt = r.choices?.[0]?.message?.content?.trim() || "{}";
    const j = JSON.parse(txt);
    if (!j.updates) j.updates = {};
    // Respaldo regex por si el LLM no pesca algo
    j.updates.city ||= rxCity(message);
    j.updates.cuisine ||= rxCuisine(message);
    j.updates.budget ||= rxBudget(message);
    if (!j.intent) j.intent = RESET_RE.test(message) ? "reset" : HELLO_RE.test(message) ? "chitchat" : "update";
    return j;
  } catch {
    return { updates: { city: rxCity(message), cuisine: rxCuisine(message), budget: rxBudget(message) }, intent: "update" };
  }
}

// --------- OSM / Overpass ---------
const NOMINATIM_EMAIL = process.env.NOMINATIM_EMAIL || "remy@example.com";
const UA = `Remy/${BUILD} (${NOMINATIM_EMAIL})`;

function normalizeCity(c) {
  const s = (c || "").toLowerCase().trim();
  if (!s) return "";
  if (/^(mx|méxico|mexico)$/.test(s)) return "Ciudad de México";
  if (/^(cdmx|ciudad de mexico|mexico city)$/.test(s)) return "Ciudad de México";
  if (/^gdl$/.test(s)) return "Guadalajara";
  if (/^mty$/.test(s)) return "Monterrey";
  return c;
}

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
async function geocodeCityZone(city, zone) {
  const first = await geocode(zone ? `${zone}, ${city}` : city);
  if (!first || !first.lat || !first.lon || first.type === "country") {
    const alt = normalizeCity(city);
    if (alt !== city) return await geocode(alt);
  }
  return first;
}

const CHAIN_RE = [
  /vips/i, /sanborns/i, /toks/i, /starbucks/i, /domino/i, /pizza\s*hutm?/i,
  /little\s*caesars/i, /papa\s*john/i, /kfc/i, /burger\s*king|bk/i, /subway/i,
  /ihop/i, /chili'?s/i, /applebee'?s/i, /olive\s*garden/i, /dennys?/i,
  /sushi\s*roll/i, /wingstop/i
];
const FINE_RE = /trattoria|osteria|bistro|brasserie|steakhouse|asador|omakase|kaiseki|chef|tasting|degustaci(ó|o)n|alta\s*cocina|fine|gastronom|izakaya/i;
const STREET_RE = /tacos?|birria|pastor|barbacoa|antojitos?|garnachas?|mariscos?|pozole|tlayuda|arepa|empanada/i;

function cuisineSyn(term = "") {
  const t = term.toLowerCase();
  if (/vegetari|vegan/.test(t)) return { nameRe: "(veg|vegetari|vegan)", cuisineRe: "(vegetarian|vegan)", diet: true };
  if (/ramen/.test(t)) return { nameRe: "(ramen|noodle|izakaya|japanese)", cuisineRe: "(ramen|noodle|japanese)" };
  if (/sushi/.test(t)) return { nameRe: "(sushi|izakaya|omakase)", cuisineRe: "(sushi|japanese|omakase)" };
  if (/pizza|italian|italiana|trattoria|pasta|osteria/.test(t)) return { nameRe: "(pizza|trattoria|italian|pasta|osteria)", cuisineRe: "(pizza|italian|pasta|trattoria|osteria)" };
  if (/taco|pastor|birria|barbacoa|taquer/.test(t)) return { nameRe: "(taco|taquer|pastor|birria|barbacoa)", cuisineRe: "(mexican|taco|pastor|birria|barbacoa)" };
  if (/burger|hamburg/.test(t)) return { nameRe: "(burger|hamburg)", cuisineRe: "(burger|hamburg|american)" };
  return { nameRe: t ? t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "", cuisineRe: "" };
}
const wantsStreet = (c) => STREET_RE.test(String(c || ""));

async function overpass({ lat, lon, radius, nameRe, cuisineRe, includeFastFood, dietFlag }) {
  const around = `around:${Math.max(700, Math.min(6000, radius))},${lat},${lon}`;
  const fast = includeFastFood ? "|fast_food" : "";
  const nameF = nameRe ? `["name"~"${nameRe}",i]` : "";
  const cuisineF = cuisineRe ? `["cuisine"~"${cuisineRe}",i]` : "";
  const dietNodes = dietFlag ? `
    node["diet:vegetarian"~"yes",i](${around});
    way ["diet:vegetarian"~"yes",i](${around});
    relation["diet:vegetarian"~"yes",i](${around});
    node["diet:vegan"~"yes",i](${around});
    way ["diet:vegan"~"yes",i](${around});
    relation["diet:vegan"~"yes",i](${around});` : "";

  const data = `
[out:json][timeout:30];
(
  node["amenity"~"^(restaurant|cafe${fast})$"]${cuisineF}(${around});
  way ["amenity"~"^(restaurant|cafe${fast})$"]${cuisineF}(${around});
  relation["amenity"~"^(restaurant|cafe${fast})$"]${cuisineF}(${around});
  node["amenity"~"^(restaurant|cafe${fast})$"]${nameF}(${around});
  way ["amenity"~"^(restaurant|cafe${fast})$"]${nameF}(${around});
  relation["amenity"~"^(restaurant|cafe${fast})$"]${nameF}(${around});
  ${dietNodes}
);
out center tags 120;`;
  const r = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
    body: new URLSearchParams({ data }).toString(),
  });
  if (!r.ok) throw new Error("Overpass " + r.status);
  const j = await r.json();
  return j?.elements || [];
}

function toPlace(e) {
  const t = e.tags || {};
  const center = e.type === "node" ? { lat: e.lat, lon: e.lon } : e.center || null;
  const addr = [
    (t["addr:street"] || "") + (t["addr:housenumber"] ? ` ${t["addr:housenumber"]}` : ""),
    t["addr:suburb"] || t["addr:neighbourhood"] || "",
    t["addr:city"] || "",
  ].filter(Boolean).join(", ");
  return {
    id: `${e.type}/${e.id}`,
    name: t.name || "",
    cuisines: (t.cuisine || "").split(";").map(s => s.trim()).filter(Boolean),
    address: addr,
    amenity: t.amenity || "",
    lat: center?.lat || null,
    lon: center?.lon || null,
    hasContact: !!(t.website || t.phone || t["contact:website"] || t["contact:phone"]),
    tags: t,
  };
}
function dedupe(arr) {
  const seen = new Set();
  return arr.filter(p => {
    const k = (p.name + "|" + p.address).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}
function score(p, wantStreet, wantCuisine) {
  let s = 0;
  if (p.amenity === "restaurant") s += 1;
  if (p.cuisines.length) s += 2;
  if (p.hasContact) s += 2;
  if (wantCuisine) {
    const { cuisineRe, nameRe } = cuisineSyn(wantCuisine);
    const re = (cuisineRe || nameRe) ? new RegExp(cuisineRe || nameRe, "i") : null;
    if (re) {
      if (re.test(p.name)) s += 3;
      if (p.cuisines.some(c => re.test(c))) s += 2;
    }
  }
  if (FINE_RE.test(p.name)) s += 2;
  if (wantStreet && p.amenity === "fast_food") s += 2;
  if (CHAIN_RE.some(re => re.test(p.name)) || p.tags.brand || p.tags["brand:wikidata"]) s -= 4;
  return s;
}
async function searchPlaces({ lat, lon, cuisine = "", zoneProvided = false }) {
  const { nameRe, cuisineRe, diet } = cuisineSyn(cuisine);
  const includeFast = wantsStreet(cuisine);
  let radius = zoneProvided ? 1500 : includeFast ? 2500 : 3500;

  let el = await overpass({ lat, lon, radius, nameRe, cuisineRe, includeFastFood: includeFast, dietFlag: diet });
  if (!el.length) { radius = Math.min(6000, radius + 2500);
    el = await overpass({ lat, lon, radius, nameRe, cuisineRe, includeFastFood: includeFast, dietFlag: diet }); }
  if (!el.length && nameRe) {
    el = await overpass({ lat, lon, radius, nameRe, cuisineRe: "", includeFastFood: includeFast, dietFlag: diet }); }
  if (!el.length) {
    el = await overpass({ lat, lon, radius, nameRe: "", cuisineRe: "", includeFastFood: includeFast, dietFlag: false }); }

  const places = dedupe(el.map(toPlace))
    .map(p => ({ ...p, score: score(p, includeFast, cuisine) }))
    .sort((a, b) => b.score - a.score);

  return places.slice(0, 12);
}

// --------- Respuestas ---------
function greet(lang) {
  return lang === "es"
    ? "¡Hola! Soy Remy 👋 Puedo sugerirte lugares cerca de ti. ¿En qué ciudad estás?"
    : "Hey! I'm Remy 👋 I can suggest great spots near you. Which city are you in?";
}
function askOne(slot, lang) {
  const es = lang === "es";
  const m = {
    city: es ? "¿En qué ciudad estás?" : "Which city are you in?",
    zone: es ? "¿Alguna zona/colonia preferida?" : "Any area/neighborhood?",
    cuisine: es ? "¿Qué se te antoja?" : "What are you craving?",
    budget: es ? "¿Presupuesto aproximado por persona?" : "Approx budget per person?",
  };
  return m[slot] || (es ? "¿Cómo te ayudo?" : "How can I help?");
}
function listMsg(results, lang, ctx) {
  const es = lang === "es";
  const head = es ? `Aquí van algunas opciones${ctx ? ` en ${ctx}` : ""}:`
                  : `Here are some options${ctx ? ` in ${ctx}` : ""}:`;
  const body = results.slice(0, 3).map(p => {
    const cuis = p.cuisines?.length ? ` (${p.cuisines.slice(0, 2).join(", ")})` : "";
    const addr = p.address ? ` — ${p.address}` : "";
    return `• ${p.name}${cuis}${addr}`;
  }).join("\n");
  return `${head}\n${body}`;
}
function gentleGuide(lang, city, cuisine) {
  const es = lang === "es";
  if (es) {
    return `Te dejo ideas rápidas${city ? ` en ${city}` : ""}${cuisine ? ` para ${cuisine}` : ""}:\n• Zonas con vida gastronómica (centro, barrios populares).\n• Menús cortos y buena rotación suelen ser aciertos.\n¿Afinamos por colonia o cambiamos de cocina?`;
  }
  return `Quick pointers${city ? ` in ${city}` : ""}${cuisine ? ` for ${cuisine}` : ""}:\n• Head to lively food districts.\n• Short menus with high turnover are usually great.\nWant me to narrow by area or switch cuisine?`;
}

// --------- API ---------
app.get("/", (_, res) => res.send(`remy-ai-backend ${BUILD}`));

app.post("/recommendation", async (req, res) => {
  const {
    message = "",
    username = "",
    manychat_user_id = "",
    city = "", zone = "", cuisine = "", budget = "", slots: bodySlots = {}
  } = req.body || {};
  if (!manychat_user_id) return res.status(400).json({ error: "manychat_user_id is required" });

  try {
    const sess = getS(manychat_user_id);
    sess.lang = keepLang(message || username, sess.lang);

    // NLU + fallback regex
    let slots = saveSlots(manychat_user_id, { ...sess.slots, city, zone, cuisine, budget, ...(bodySlots || {}) });
    const nlu = await extractNLU(message, slots);

    if (nlu.intent === "reset" || RESET_RE.test(message)) {
      resetS(manychat_user_id);
      return res.json({
        reply: sess.lang === "es"
          ? "Listo, reinicié la conversación. ¿En qué ciudad estás y qué se te antoja?"
          : "Done, I reset our chat. Which city are you in and what are you craving?",
        followup: askOne("city", sess.lang),
        slots: getS(manychat_user_id).slots,
        next_slot: "city",
      });
    }

    // Saludo amable: responde y ya pide ciudad (sin forzar)
    if (HELLO_RE.test(message) || nlu.intent === "chitchat") {
      return res.json({
        reply: greet(sess.lang),
        followup: askOne("city", sess.lang),
        slots,
        next_slot: "city"
      });
    }

    if (nlu.updates) slots = saveSlots(manychat_user_id, nlu.updates);

    // Si aún no hay ciudad: propone acción clara pero con tono amable
    if (!slots.city) {
      return res.json({
        reply: sess.lang === "es"
          ? "Para darte buenas sugerencias necesito tu ciudad."
          : "To suggest great places I need your city.",
        followup: askOne("city", sess.lang),
        slots, next_slot: "city"
      });
    }

    // Geocodifica y busca
    const pin = await geocodeCityZone(normalizeCity(slots.city), slots.zone);
    if (!pin?.lat || !pin?.lon) {
      return res.json({
        reply: sess.lang === "es"
          ? `No ubico bien ${slots.zone ? `${slots.zone}, ` : ""}${slots.city}.`
          : `I couldn't locate ${slots.zone ? `${slots.zone}, ` : ""}${slots.city}.`,
        followup: askOne("zone", sess.lang),
        slots, next_slot: "zone"
      });
    }

    const results = await searchPlaces({
      lat: parseFloat(pin.lat), lon: parseFloat(pin.lon),
      cuisine: slots.cuisine, zoneProvided: !!slots.zone
    });

    if (results.length) {
      const ctx = [slots.city, slots.zone].filter(Boolean).join(", ");
      let ask = "";
      if (!slots.cuisine && sess.lastAsked !== "cuisine") ask = askOne("cuisine", sess.lang);
      else if (!slots.zone && sess.lastAsked !== "zone") ask = askOne("zone", sess.lang);
      else if (!slots.budget && sess.lastAsked !== "budget") ask = askOne("budget", sess.lang);
      sess.lastAsked = ask ? (ask.includes("zona") || ask.includes("area") ? "zone"
                        : ask.includes("antoja") || ask.includes("craving") ? "cuisine"
                        : ask.includes("Presupuesto") || ask.includes("budget") ? "budget" : "") : "";

      return res.json({
        reply: listMsg(results, sess.lang, ctx),
        followup: ask,
        slots,
        next_slot: sess.lastAsked || ""
      });
    }

    // Sin resultados: nunca “no encontré…”, da guía y 1 pregunta útil
    const guide = gentleGuide(sess.lang, slots.city, slots.cuisine);
    const ask = sess.lastAsked === "zone" ? askOne("cuisine", sess.lang)
               : sess.lastAsked === "cuisine" ? askOne("zone", sess.lang)
               : askOne("zone", sess.lang);
    sess.lastAsked = ask.includes("zona") || ask.includes("area") ? "zone" : "cuisine";
    return res.json({
      reply: guide,
      followup: ask,
      slots,
      next_slot: sess.lastAsked
    });

  } catch (err) {
    console.error(err);
    const lang = getS(manychat_user_id)?.lang || guessLang(message);
    return res.status(500).json({
      reply: lang === "es" ? "Tuve un problema técnico. Intentemos de nuevo." : "I hit a technical snag. Let's try again.",
      followup: "",
      error: "internal_error"
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Remy ${BUILD} listening on :${PORT}`));

