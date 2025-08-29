// Remy Backend v3.1 – diálogo más fluido, idioma consistente, búsqueda amplia
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { OpenAI } from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const BUILD = "3.1.0";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------------------- SESIONES ----------------------
const SESSIONS = new Map();
function getSession(id) {
  if (!SESSIONS.has(id)) {
    SESSIONS.set(id, {
      lang: "es",
      slots: { city: "", zone: "", cuisine: "", budget: "" },
      lastAsked: "", // city | zone | cuisine | budget
      lastUpdated: Date.now(),
    });
  }
  return SESSIONS.get(id);
}
function setSlots(id, upd = {}) {
  const s = getSession(id);
  const norm = (v) => (typeof v === "string" ? v.trim() : v || "");
  const slots = { ...s.slots, ...upd };
  if (slots.budget) {
    const m = String(slots.budget).match(/\d{2,6}/);
    slots.budget = m ? m[0] : "";
  }
  s.slots = {
    city: norm(slots.city),
    zone: norm(slots.zone),
    cuisine: norm(slots.cuisine),
    budget: norm(slots.budget),
  };
  s.lastUpdated = Date.now();
  return s.slots;
}
function resetSession(id) {
  const s = getSession(id);
  s.slots = { city: "", zone: "", cuisine: "", budget: "" };
  s.lastAsked = "";
  s.lastUpdated = Date.now();
}

// ---------------------- IDIOMA ----------------------
function detectLangFast(text) {
  const s = (text || "").toLowerCase();
  if (/[áéíóúñü¿¡]/.test(s)) return "es";
  if (/(hola|estoy|ciudad|zona|presupuesto|quiero|tacos|ramen|cdmx|méxico|mexico)/i.test(s)) return "es";
  return "en";
}
function chooseLang(message, sessionLang = "es") {
  const guess = detectLangFast(message);
  // si el guess es claro, úsalo; si no, conserva el de la sesión
  return guess || sessionLang || "es";
}

// ---------------------- NLU (ligero) ----------------------
async function extractNLU(message, prevSlots) {
  const sys = `Devuelve SOLO JSON con este shape exacto:
{
  "updates": { "city": "", "zone": "", "cuisine": "", "budget": "" },
  "intent": "recommend|update|reset|chitchat|why|unknown"
}
Reglas breves:
- "olvida", "reset", "empecemos de nuevo" => intent="reset".
- "estoy en/ahora en ..." => updates.city.
- "en la zona de/por ..." => updates.zone.
- "se me antoja/quiero ..." => updates.cuisine.
- "$300/300 pesos" => updates.budget (solo números).
- "why?/¿por qué?" => intent="why".`;
  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        { role: "system", content: sys },
        {
          role: "user",
          content: `msg: """${message}"""
prev: ${JSON.stringify(prevSlots)}`,
        },
      ],
    });
    const raw = r.choices?.[0]?.message?.content?.trim() || "{}";
    const j = JSON.parse(raw);
    if (!j.updates) j.updates = {};
    // regex de respaldo para budget
    if (!j.updates.budget) {
      const m = message.match(/\$?\s?(\d{2,5})\s*(mxn|pesos|usd)?/i);
      if (m) j.updates.budget = m[1];
    }
    return j;
  } catch {
    return { updates: {}, intent: "unknown" };
  }
}

// ---------------------- OSM / Overpass ----------------------
const NOMINATIM_EMAIL = process.env.NOMINATIM_EMAIL || "remy@example.com";
const UA = `Remy/${BUILD} (${NOMINATIM_EMAIL})`;

function normCityInput(cityRaw) {
  const s = (cityRaw || "").toLowerCase().trim();
  if (!s) return "";
  if (/^(mx|mexico|méxico)$/.test(s)) return "Ciudad de México";
  if (/^(cdmx|ciudad de mexico|mexico city)$/.test(s)) return "Ciudad de México";
  if (/^gdl$/.test(s)) return "Guadalajara";
  if (/^mty$/.test(s)) return "Monterrey";
  return cityRaw;
}

async function geocode(q) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", q);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", "1");
  url.searchParams.set("email", NOMINATIM_EMAIL);
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) return null;
  const arr = await r.json();
  return arr?.[0] || null;
}

async function geocodeCityZone(city, zone) {
  const first = await geocode(zone ? `${zone}, ${city}` : city);
  if (!first || !first.lat || !first.lon || first.type === "country") {
    const c = normCityInput(city);
    if (c !== city) return await geocode(c);
  }
  return first;
}

const CHAIN_RE = [
  /vips/i, /sanborns/i, /toks/i, /starbucks/i, /domino/i, /pizza\s*hutm?/i,
  /little\s*caesars/i, /papa\s*john/i, /kfc/i, /burger\s*king|bk/i, /subway/i,
  /ihop/i, /chili'?s/i, /applebee'?s/i, /hooters/i, /olive\s*garden/i, /dennys?/i,
  /sushi\s*roll/i, /wingstop/i
];

const FINE_RE = [
  /trattoria|osteria|bistro|brasserie|steakhouse|asador|omakase|kaiseki|chef|tasting|degustaci(ó|o)n|alta\s*cocina|fine|gastronom|izakaya/i
];

const STREET_RE = [
  /tacos?|birria|pastor|barbacoa|antojitos?|garnachas?|mariscos?|pozole|tlayuda|arepa|empanada/i
];

function cuisineSyn(term = "") {
  const t = term.toLowerCase();
  if (/vegetari|vegan/.test(t)) return { nameRe: "(veg|vegetari|vegan)", cuisineRe: "(vegetarian|vegan)", diet: true };
  if (/ramen/.test(t)) return { nameRe: "(ramen|noodle|izakaya|japanese)", cuisineRe: "(ramen|noodle|japanese)" };
  if (/sushi/.test(t)) return { nameRe: "(sushi|izakaya|omakase)", cuisineRe: "(sushi|japanese|omakase)" };
  if (/pizza/.test(t)) return { nameRe: "(pizza|trattoria|italian)", cuisineRe: "(pizza|italian|pasta|trattoria)" };
  if (/taco|pastor|birria|barbacoa/.test(t)) return { nameRe: "(taco|taquer|pastor|birria|barbacoa)", cuisineRe: "(mexican|taco|pastor|birria|barbacoa)" };
  if (/italian|italiana|pasta/.test(t)) return { nameRe: "(italian|trattoria|osteria|pasta)", cuisineRe: "(italian|pasta|trattoria|osteria)" };
  if (/burger|hamburg/.test(t)) return { nameRe: "(burger|hamburg)", cuisineRe: "(burger|hamburg|american)" };
  return { nameRe: t ? t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "", cuisineRe: "" };
}

function streetWanted(cuisine) {
  return STREET_RE.some((re) => re.test(String(cuisine || "")));
}

async function overpass({ lat, lon, radius, nameRe, cuisineRe, includeFastFood, dietFlag }) {
  const around = `around:${Math.max(700, Math.min(6000, radius))},${lat},${lon}`;
  const fast = includeFastFood ? "|fast_food" : "";
  const nameF = nameRe ? `["name"~"${nameRe}",i]` : "";
  const cuisineF = cuisineRe ? `["cuisine"~"${cuisineRe}",i]` : "";

  const dietF = dietFlag
    ? `["diet:vegetarian"~"yes",i];node["diet:vegan"~"yes",i](${around});way["diet:vegan"~"yes",i](${around});relation["diet:vegan"~"yes",i](${around});`
    : "";

  const data = `
[out:json][timeout:30];
(
  node["amenity"~"^(restaurant|cafe${fast})$"]${cuisineF}(${around});
  way ["amenity"~"^(restaurant|cafe${fast})$"]${cuisineF}(${around});
  relation["amenity"~"^(restaurant|cafe${fast})$"]${cuisineF}(${around});
  node["amenity"~"^(restaurant|cafe${fast})$"]${nameF}(${around});
  way ["amenity"~"^(restaurant|cafe${fast})$"]${nameF}(${around});
  relation["amenity"~"^(restaurant|cafe${fast})$"]${nameF}(${around});
  ${dietF}
);
out center tags 120;`;

  const r = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
    body: new URLSearchParams({ data }).toString(),
  });
  if (!r.ok) throw new Error("Overpass " + r.status);
  const json = await r.json();
  return json?.elements || [];
}

function scorePlace(p, wantStreet, wantCuisine) {
  let score = 0;
  if (p.amenity === "restaurant") score += 1;
  if (p.cuisines.length) score += 2;
  if (p.hasContact) score += 2;

  // coincidencia blanda
  if (wantCuisine) {
    const re = new RegExp(cuisineSyn(wantCuisine).cuisineRe || cuisineSyn(wantCuisine).nameRe, "i");
    if (re.test(p.name)) score += 3;
    if (p.cuisines.some((c) => re.test(c))) score += 2;
  }

  if (FINE_RE.some((re) => re.test(p.name))) score += 2;
  if (wantStreet && p.amenity === "fast_food") score += 2;

  // penaliza cadenas, no bloquea
  if (CHAIN_RE.some((re) => re.test(p.name)) || p.tags.brand || p.tags["brand:wikidata"]) score -= 4;

  return score;
}

function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const p of arr) {
    const k = (p.name + "|" + p.address).toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(p); }
  }
  return out;
}

async function searchPlaces({ lat, lon, cuisine = "", zoneProvided = false }) {
  const { nameRe, cuisineRe, diet } = cuisineSyn(cuisine);
  const includeFast = streetWanted(cuisine);
  let radius = zoneProvided ? 1500 : includeFast ? 2500 : 3500;

  // 1) cuisine OR name + diet
  let el = await overpass({ lat, lon, radius, nameRe, cuisineRe, includeFastFood: includeFast, dietFlag: diet });

  // 2) si nada, ampliar radio
  if (!el.length) {
    radius = Math.min(6000, radius + 2000);
    el = await overpass({ lat, lon, radius, nameRe, cuisineRe, includeFastFood: includeFast, dietFlag: diet });
  }
  // 3) si nada, probar sólo name
  if (!el.length && nameRe) {
    el = await overpass({ lat, lon, radius, nameRe, cuisineRe: "", includeFastFood: includeFast, dietFlag: diet });
  }
  // 4) si nada, sin filtros
  if (!el.length) {
    el = await overpass({ lat, lon, radius, nameRe: "", cuisineRe: "", includeFastFood: includeFast, dietFlag: false });
  }

  const places = (el || []).map((e) => {
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
      cuisines: (t.cuisine || "").split(";").map((s) => s.trim()).filter(Boolean),
      address: addr,
      amenity: t.amenity || "",
      lat: center?.lat || null,
      lon: center?.lon || null,
      hasContact: !!(t.website || t.phone || t["contact:website"] || t["contact:phone"]),
      tags: t,
    };
  });

  const scored = dedupe(places)
    .map((p) => ({ ...p, score: scorePlace(p, includeFast, cuisine) }))
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, 12);
}

// ---------------------- RESPUESTAS ----------------------
function singleAsk(slot, lang) {
  const es = lang === "es";
  const map = {
    city: es ? "¿En qué ciudad estás?" : "Which city are you in?",
    zone: es ? "¿Alguna zona/colonia preferida?" : "Any area or neighborhood?",
    cuisine: es ? "¿Qué se te antoja?" : "What are you craving?",
    budget: es ? "¿Presupuesto aprox. por persona?" : "Approx budget per person?",
  };
  return map[slot] || (es ? "¿Cómo te ayudo?" : "How can I help?");
}

function craftList(results, lang, ctx) {
  const es = lang === "es";
  const head = es
    ? `Aquí van algunas opciones${ctx ? ` en ${ctx}` : ""}:`
    : `Here are some options${ctx ? ` in ${ctx}` : ""}:`;
  const body = results.slice(0, 3).map(p => {
    const cuis = p.cuisines?.length ? ` (${p.cuisines.slice(0,2).join(", ")})` : "";
    const addr = p.address ? ` — ${p.address}` : "";
    return `• ${p.name}${cuis}${addr}`;
  }).join("\n");
  return `${head}\n${body}`;
}

function craftFallbackGuide(lang, city, cuisine) {
  const es = lang === "es";
  if (es) {
    return `No encontré coincidencias exactas ${city ? `en ${city}` : ""}, pero te dejo ideas para empezar${
      cuisine ? ` con ${cuisine}` : ""
    }:\n• Busca en zonas vivas (centro histórico, barrios gastronómicos).\n• Prueba lugares con menú corto y buena rotación.\n¿Te acoto por colonia o cambiamos la cocina?`;
  }
  return `I didn't find exact matches${city ? ` in ${city}` : ""}, but here are quick pointers${
    cuisine ? ` for ${cuisine}` : ""
  }:\n• Try lively food districts.\n• Short menus with high turnover usually shine.\nWant me to narrow by neighborhood or switch cuisine?`;
}

// ---------------------- API ----------------------
app.get("/", (_, res) => res.send(`remy-ai-backend ${BUILD}`));

app.post("/recommendation", async (req, res) => {
  const {
    message = "",
    username = "",
    manychat_user_id = "",
    // opcional: estado que nos manda Manychat para no depender de RAM del server
    city = "", zone = "", cuisine = "", budget = "", slots: bodySlots = {}
  } = req.body || {};

  if (!manychat_user_id) return res.status(400).json({ error: "manychat_user_id is required" });

  try {
    const s = getSession(manychat_user_id);
    // idioma consistente por último mensaje
    s.lang = chooseLang(message || username, s.lang);

    // merge slots (del server y los que vengan de Manychat)
    let slots = setSlots(manychat_user_id, { ...s.slots, city, zone, cuisine, budget, ...(bodySlots || {}) });

    // NLU ligero
    const nlu = await extractNLU(message, slots);
    if (nlu.intent === "reset") {
      resetSession(manychat_user_id);
      return res.json({
        reply: s.lang === "es"
          ? "Listo, reinicié la conversación. ¿En qué ciudad estás y qué se te antoja?"
          : "Done, I reset our chat. Which city are you in and what are you craving?",
        followup: singleAsk("city", s.lang),
        slots: getSession(manychat_user_id).slots,
        next_slot: "city",
      });
    }
    if (nlu.updates) {
      slots = setSlots(manychat_user_id, nlu.updates);
    }

    // Si falta ciudad, pregunta UNA vez (no repite)
    if (!slots.city) {
      s.lastAsked = "city";
      return res.json({
        reply: s.lang === "es"
          ? "Para recomendar algo, dime en qué ciudad estás."
          : "To recommend something, tell me which city you're in.",
        followup: singleAsk("city", s.lang),
        slots, next_slot: "city"
      });
    }

    // Geocodifica
    const place = await geocodeCityZone(normCityInput(slots.city), slots.zone);
    if (!place?.lat || !place?.lon) {
      s.lastAsked = "zone";
      return res.json({
        reply: s.lang === "es"
          ? `No ubico bien ${slots.zone ? `${slots.zone}, ` : ""}${slots.city}.`
          : `I couldn't locate ${slots.zone ? `${slots.zone}, ` : ""}${slots.city}.`,
        followup: singleAsk("zone", s.lang),
        slots, next_slot: "zone"
      });
    }

    // Busca lugares (amplio + tolerante)
    const results = await searchPlaces({
      lat: parseFloat(place.lat),
      lon: parseFloat(place.lon),
      cuisine: slots.cuisine,
      zoneProvided: !!slots.zone,
    });

    // Si hay resultados, lista y UNA pregunta para afinar (no repite la misma)
    if (results.length) {
      const ctx = [slots.city, slots.zone].filter(Boolean).join(", ");
      const reply = craftList(results, s.lang, ctx);

      // decide qué pedir después (pero no repitas lo ya pedido)
      let ask = "";
      if (!slots.cuisine && s.lastAsked !== "cuisine") ask = singleAsk("cuisine", s.lang);
      else if (!slots.zone && s.lastAsked !== "zone") ask = singleAsk("zone", s.lang);
      else if (!slots.budget && s.lastAsked !== "budget") ask = singleAsk("budget", s.lang);
      s.lastAsked = ask ? (ask.includes("zona") || ask.includes("area") ? "zone" :
                          ask.includes("antoja") || ask.includes("craving") ? "cuisine" :
                          ask.includes("Presupuesto") || ask.includes("budget") ? "budget" : "") : "";

      return res.json({
        reply,
        followup: ask,
        slots,
        next_slot: s.lastAsked || ""
      });
    }

    // Si el usuario preguntó "why?"
    if (nlu.intent === "why") {
      const msg = s.lang === "es"
        ? "Probé varias combinaciones (por cocina y por nombre) cerca de tu zona y no vi coincidencias claras. Puedo ampliar el radio o cambiar la cocina. ¿Prefieres que amplíe el radio o probamos otra cocina?"
        : "I tried several combinations (by cuisine and by name) near your area and didn't see clear matches. I can expand the radius or switch cuisine. Should I widen the radius or try a different cuisine?";
      return res.json({
        reply: msg,
        followup: s.lang === "es" ? "¿Amplío el radio o cambiamos cocina?" : "Widen radius or switch cuisine?",
        slots, next_slot: ""
      });
    }

    // Fallback amable (guía corta), nunca “no encontré…”
    const guide = craftFallbackGuide(s.lang, slots.city, slots.cuisine);
    // Pregunta única útil (no repetir la última)
    const askNext = s.lastAsked === "zone" ? singleAsk("cuisine", s.lang) :
                    s.lastAsked === "cuisine" ? singleAsk("zone", s.lang) :
                    singleAsk("zone", s.lang);
    s.lastAsked = askNext.includes("zona") || askNext.includes("area") ? "zone" : "cuisine";

    return res.json({
      reply: guide,
      followup: askNext,
      slots,
      next_slot: s.lastAsked
    });

  } catch (e) {
    console.error(e);
    const s = getSession(req.body?.manychat_user_id || "");
    const lang = s?.lang || detectLangFast(req.body?.message || "");
    return res.status(500).json({
      reply: lang === "es" ? "Tuve un problema técnico. Intentemos de nuevo." : "I hit a technical snag. Let's try again.",
      followup: "",
      error: "internal_error"
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Remy ${BUILD} on :${PORT}`));
