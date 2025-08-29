// index.js — Remy v2.7 (más suelto, mejores hallazgos)
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { OpenAI } from "openai";
// Si tu runtime no tiene fetch global, descomenta:
// import fetch from "node-fetch"; globalThis.fetch = fetch;

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const BUILD_VERSION = "2.7.0";

app.get("/", (_req, res) => res.send(`remy-ai-backend v${BUILD_VERSION}`));

/* ===================== Memoria ===================== */
const SESSIONS = new Map();
function getSession(id) {
  if (!SESSIONS.has(id)) {
    SESSIONS.set(id, {
      slots: { city: "", zone: "", cuisine: "", budget: "" },
      lastUpdated: Date.now(),
    });
  }
  return SESSIONS.get(id);
}
function cleanSlots(slots) {
  const norm = (v) => (typeof v === "string" ? v.trim() : v || "");
  const out = {
    city: norm(slots.city),
    zone: norm(slots.zone),
    cuisine: norm(slots.cuisine),
    budget: norm(slots.budget),
  };
  if (out.budget && /\d/.test(out.budget)) {
    const m = String(out.budget).match(/\d{2,6}/);
    out.budget = m ? m[0] : "";
  } else out.budget = "";
  return out;
}
function setSlots(id, updates = {}) {
  const s = getSession(id);
  s.slots = { ...s.slots, ...cleanSlots(updates) };
  s.lastUpdated = Date.now();
  SESSIONS.set(id, s);
  return s.slots;
}
function resetSession(id) {
  SESSIONS.set(id, {
    slots: { city: "", zone: "", cuisine: "", budget: "" },
    lastUpdated: Date.now(),
  });
}
function nextSlot(slots) {
  if (!slots.city) return "city";
  if (!slots.cuisine && !slots.zone) return "cuisine_or_zone";
  if (!slots.budget) return "budget";
  return "";
}

/* ===================== Idioma ===================== */
function heuristicLang(str) {
  const s = (str || "").toLowerCase();
  if (/[áéíóúñü¿¡]/.test(s)) return "es";
  if (/(hola|quiero|estoy|ciudad|zona|presupuesto|antojo|buscar|recomienda|méxico|mexico|cdmx|guadalajara|monterrey|tacos|taquer)/i.test(
    s
  )) return "es";
  return "en";
}

/* ===================== NLU simple ===================== */
async function extractNLU({ message, slots }) {
  const sys = `Devuelve SOLO JSON:
{
  "updates": { "city": "", "zone": "", "cuisine": "", "budget": "" },
  "negations": { "city_from": "" },
  "intent": "recommend|update|reset|unknown"
}
Reglas:
- "olvida todo", "reset", "empecemos de nuevo" => intent="reset".
- "ya no estoy en X" => negations.city_from = "X".
- "estoy en/ahora en X" => updates.city.
- "en la zona de Y/cerca de Y/por Y" => updates.zone.
- "se me antoja/quiero X" => updates.cuisine.
- "$300, 300 pesos, 300 mxn" => updates.budget numérica.`;
  const user = `Mensaje: """${message}"""
Slots previos: ${JSON.stringify(slots)}`;
  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [{ role: "system", content: sys }, { role: "user", content: user }],
    });
    const raw = r.choices?.[0]?.message?.content?.trim() || "{}";
    const parsed = JSON.parse(raw);
    if (!parsed?.updates?.budget) {
      const m = message.match(/\$?\s?(\d{2,5})\s*(mxn|pesos)?/i);
      if (m) parsed.updates.budget = m[1];
    }
    return parsed;
  } catch {
    return { updates: {}, negations: { city_from: "" }, intent: "unknown" };
  }
}

/* ===================== OSM helpers ===================== */
const NOMINATIM_EMAIL = process.env.NOMINATIM_EMAIL || "remy@example.com";
const UA = `RemyBot/${BUILD_VERSION} (${NOMINATIM_EMAIL})`;

function normCityInput(cityRaw) {
  const s = (cityRaw || "").toLowerCase().trim();
  if (!s) return "";
  // Normalización útil para MX
  if (/^(mx|méxico|mexico)$/.test(s)) return "Ciudad de México";
  if (/^(cdmx|ciudad de mexico|mexico city)$/.test(s)) return "Ciudad de México";
  if (/^gdl$/.test(s)) return "Guadalajara";
  if (/^mty$/.test(s)) return "Monterrey";
  return cityRaw;
}

async function geocodePlace(q) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", q);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", "1");
  url.searchParams.set("email", NOMINATIM_EMAIL);
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error("Nominatim " + r.status);
  const arr = await r.json();
  return arr?.[0] || null;
}
async function geocodeCityZone(city, zone) {
  if (!city) return null;
  const firstTry = await geocodePlace(zone ? `${zone}, ${city}` : city);
  // Si te devolvió el país (o algo sin lat/lon útiles), forzamos a CDMX si aplica
  const badType = !firstTry || !firstTry.lat || !firstTry.lon || firstTry.type === "country";
  if (badType) {
    const c = normCityInput(city);
    if (c !== city) return await geocodePlace(c);
  }
  return firstTry;
}

const CHAIN_HINT = [
  /vips/i, /sanborns/i, /toks/i, /starbucks/i, /mcdonald/i, /burger\s*king|bk/i,
  /kfc/i, /carls?\s*jr/i, /domino'?s/i, /pizza\s*hutm?/i, /little\s*caesars/i,
  /papa\s*john'?s/i, /sushi\s*roll/i, /wingstop|wings/i, /chili'?s/i, /applebee'?s/i,
  /olive\s*garden/i, /ihop/i, /cheesecake\s*factory/i, /dennys/i, /hooters/i,
  /taco\s*bell/i, /subway/i
];
function chainPenalty(name, tags = {}) {
  if (!name) return 0;
  if (tags.brand || tags["brand:wikidata"]) return -4;
  return CHAIN_HINT.some((re) => re.test(name)) ? -4 : 0; // penalización fuerte, no bloqueo
}
function esc(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const p of arr) {
    const k = (p.name + "|" + (p.address || "")).toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(p);
    }
  }
  return out;
}

const FINE_DINING_HINTS = [
  /trattoria/i, /osteria/i, /bistro/i, /brasserie/i, /steakhouse/i, /asador/i,
  /omakase/i, /kaiseki/i, /chef/i, /tasting/i, /degustaci(ó|o)n/i,
  /alta\s*cocina/i, /fine/i, /gastronom/i, /izakaya/i
];
const STREET_CUES = [
  /tacos?/i, /birria/i, /pastor/i, /barbacoa/i, /antojitos?/i, /garnachas?/i,
  /mariscos?/i, /pozole/i, /tlayuda/i
];
function wantStreetFood(cuisine) {
  if (!cuisine) return false;
  return STREET_CUES.some((re) => re.test(cuisine));
}
function fineDiningBoostByName(name) {
  if (!name) return 0;
  return FINE_DINING_HINTS.some((re) => re.test(name)) ? 2 : 0;
}

// Sinónimos para ampliar match por "cuisine" o "name"
function cuisineRegexFor(termRaw) {
  const t = (termRaw || "").toLowerCase();
  if (!t) return "";
  if (/ramen/.test(t)) return "(ramen|noodle|noodles|japanese|izakaya)";
  if (/sushi/.test(t)) return "(sushi|japanese|izakaya|omakase)";
  if (/taco|pastor|birria|barbacoa/.test(t)) return "(taco|taquer|mexican|pastor|birria|barbacoa)";
  if (/pizza/.test(t)) return "(pizza|italian|trattoria|pizz?er)";
  if (/hamburg|burger/.test(t)) return "(burger|hamburg)";
  if (/steak|asador|parrilla|brasa/.test(t)) return "(steak|asador|parrill|brasa)";
  if (/marisc|sea ?food/.test(t)) return "(marisc|sea\\s*food)";
  if (/italian|italiana|pasta/.test(t)) return "(italian|italiana|pasta|trattoria|osteria)";
  return esc(t); // por defecto
}

async function overpassQuery({ lat, lon, radius, nameRegex, cuisineRegex, includeFastFood }) {
  const around = `around:${Math.max(600, Math.min(6000, radius))},${lat},${lon}`;
  const fast = includeFastFood ? "|fast_food" : "";
  const nameFilter = nameRegex ? `["name"~"${nameRegex}",i]` : "";
  const cuisineFilter = cuisineRegex ? `["cuisine"~"${cuisineRegex}",i]` : "";

  // Unimos (cuisine OR name)
  const q = `
[out:json][timeout:30];
(
  node["amenity"~"^(restaurant|cafe${fast})$"]${cuisineFilter}(${around});
  way ["amenity"~"^(restaurant|cafe${fast})$"]${cuisineFilter}(${around});
  relation["amenity"~"^(restaurant|cafe${fast})$"]${cuisineFilter}(${around});
  node["amenity"~"^(restaurant|cafe${fast})$"]${nameFilter}(${around});
  way ["amenity"~"^(restaurant|cafe${fast})$"]${nameFilter}(${around});
  relation["amenity"~"^(restaurant|cafe${fast})$"]${nameFilter}(${around});
);
out center tags 120;`;

  const r = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": UA,
    },
    body: new URLSearchParams({ data: q }).toString(),
  });
  if (!r.ok) throw new Error("Overpass " + r.status);
  const data = await r.json();
  return data?.elements || [];
}

async function searchRestaurants({ lat, lon, radius = 3000, cuisine = "", includeFastFood = false }) {
  const cuisineRegex = cuisine ? cuisineRegexFor(cuisine) : "";
  const nameRegex = cuisine ? cuisineRegexFor(cuisine) : "";
  let elements = await overpassQuery({ lat, lon, radius, nameRegex, cuisineRegex, includeFastFood });

  // Fallbacks: si no hay nada, probar sólo name; luego sin filtros
  if (!elements.length && cuisine) {
    elements = await overpassQuery({ lat, lon, radius, nameRegex, cuisineRegex: "", includeFastFood });
  }
  if (!elements.length) {
    elements = await overpassQuery({ lat, lon, radius, nameRegex: "", cuisineRegex: "", includeFastFood });
  }

  const places = (elements || []).map((el) => {
    const t = el.tags || {};
    const center = el.type === "node" ? { lat: el.lat, lon: el.lon } : el.center || null;
    const cuisines = (t.cuisine || "").split(";").map((s) => s.trim()).filter(Boolean);
    const address = [
      (t["addr:street"] || "") + (t["addr:housenumber"] ? ` ${t["addr:housenumber"]}` : ""),
      t["addr:neighbourhood"] || t["addr:suburb"] || "",
      t["addr:city"] || ""
    ].filter(Boolean).join(", ");
    return {
      id: `${el.type}/${el.id}`,
      name: t.name || "",
      cuisines,
      address,
      lat: center?.lat || null,
      lon: center?.lon || null,
      tags: t,
      amenity: t.amenity || "",
      hasContact: !!(t.website || t.phone || t["contact:phone"] || t["contact:website"]),
    };
  });

  const streetWanted = wantStreetFood(cuisine);

  const scored = dedupe(places)
    .map((p) => {
      let score = 0;
      // Positivos
      if (p.cuisines.length) score += 3;
      if (p.address) score += 2;
      if (p.amenity === "restaurant") score += 1;
      if (p.hasContact) score += 2;

      // Coincidencia aproximada por nombre/cuisine
      if (cuisine) {
        const regex = new RegExp(cuisineRegexFor(cuisine), "i");
        if (regex.test(p.name)) score += 3;
        if (p.cuisines.some((c) => regex.test(c))) score += 2;
      }

      // Fine dining
      score += fineDiningBoostByName(p.name);

      // Street food deseado
      if (streetWanted && p.amenity === "fast_food") score += 2;

      // Cadenas (penalización, sin bloquear)
      score += chainPenalty(p.name, p.tags);

      return { ...p, score };
    })
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, 12);
}

/* ===================== Redacción ===================== */
function craftReply({ lang = "es", slots, results }) {
  const { city, zone, cuisine, budget } = slots;
  const es = lang === "es";

  if (!results?.length) {
    const ask = !city
      ? es ? "¿En qué ciudad estás?" : "Which city are you in?"
      : !cuisine && !zone
        ? es ? "¿Se te antoja alguna cocina o acotamos por zona?" : "Any cuisine you crave, or should I narrow by area?"
        : es ? "¿Quieres que intente con otra zona o cocina?" : "Want me to try a different area or cuisine?";
    return {
      reply: es
        ? `No encontré lugares con esos criterios${city ? ` en ${city}` : ""}.`
        : `I couldn't find places with those criteria${city ? ` in ${city}` : ""}.`,
      followup: ask,
    };
  }

  const top = results.slice(0, 3);
  const bullet = top
    .map((p) => {
      const cuis = p.cuisines?.length ? ` (${p.cuisines.slice(0, 2).join(", ")})` : "";
      const addr = p.address ? ` — ${p.address}` : "";
      return `• ${p.name}${cuis}${addr}`;
    })
    .join("\n");

  const ctx = [city, zone].filter(Boolean).join(", ");
  const intro = es
    ? `Aquí van ${cuisine ? `algunas de ${cuisine}` : "algunas"} opciones${ctx ? ` en ${ctx}` : ""}:`
    : `Here are ${cuisine ? `some ${cuisine}` : "some"} options${ctx ? ` in ${ctx}` : ""}:`;

  const nxt = nextSlot(slots);
  let askNext = es ? "¿Quieres otra opción o afino la búsqueda?" : "Another option or a tighter search?";
  if (nxt === "cuisine_or_zone") askNext = es ? "¿Te late alguna cocina o acotamos por zona?" : "Prefer a cuisine or should I narrow by area?";
  else if (nxt === "budget") askNext = es ? "¿Presupuesto aprox. por persona?" : "Approx budget per person?";

  const budgetNote = budget ? (es ? ` (consideré ~$${budget} MXN pp)` : ` (considered ~$${budget} MXN pp)`) : "";

  return { reply: `${intro}\n${bullet}${budgetNote}`, followup: askNext };
}

/* ===================== Endpoint ===================== */
app.post("/recommendation", async (req, res) => {
  const {
    message = "",
    username = "",
    manychat_user_id = "",
    city = "",
    zone = "",
    cuisine = "",
    budget = "",
    slots: bodySlots = {},
  } = req.body || {};

  if (!manychat_user_id) return res.status(400).json({ error: "manychat_user_id is required" });

  try {
    // Trae slots desde Manychat en cada request (no dependas de memoria del server)
    let slots = setSlots(manychat_user_id, { city, zone, cuisine, budget, ...(bodySlots || {}) });

    const nlu = await extractNLU({ message, slots });

    if (nlu.intent === "reset") {
      resetSession(manychat_user_id);
      return res.json({
        reply: "Listo, reinicié la conversación. ¿En qué ciudad estás y qué se te antoja?",
        followup: "¿Ciudad y antojo?",
        slots: { city: "", zone: "", cuisine: "", budget: "" },
        next_slot: "city",
      });
    }

    if (nlu.negations?.city_from && slots.city) {
      if (slots.city.toLowerCase().includes(nlu.negations.city_from.toLowerCase())) {
        slots = setSlots(manychat_user_id, { city: "" });
      }
    }
    if (nlu.updates) slots = setSlots(manychat_user_id, nlu.updates);

    // Idioma SIEMPRE por último mensaje del usuario
    const lang = heuristicLang(message || username);

    // Si falta ciudad, pregunta, pero intenta no perder lo previo
    if (!slots.city) {
      return res.json({
        reply: lang === "es" ? "Para recomendar algo, dime en qué ciudad estás." : "To recommend something, tell me which city you're in.",
        followup: lang === "es" ? "¿En qué ciudad estás?" : "Which city are you in?",
        slots,
        next_slot: "city",
      });
    }

    const place = await geocodeCityZone(normCityInput(slots.city), slots.zone);
    if (!place?.lat || !place?.lon) {
      return res.json({
        reply: lang === "es"
          ? `No pude ubicar ${slots.zone ? `${slots.zone}, ` : ""}${slots.city}.`
          : `I couldn't locate ${slots.zone ? `${slots.zone}, ` : ""}${slots.city}.`,
        followup: lang === "es" ? "¿Me das un referente cerca (colonia, avenida)?" : "Give me a nearby area or landmark?",
        slots,
        next_slot: "zone",
      });
    }

    const streetWanted = wantStreetFood(slots.cuisine);
    const radius = slots.zone ? 1500 : streetWanted ? 2500 : 3500;

    const results = await searchRestaurants({
      lat: parseFloat(place.lat),
      lon: parseFloat(place.lon),
      radius,
      cuisine: slots.cuisine,
      includeFastFood: streetWanted,
    });

    const { reply, followup } = craftReply({ lang, slots, results });

    return res.json({
      reply,
      followup,
      slots,
      next_slot: nextSlot(slots),
    });
  } catch (err) {
    console.error(err);
    const lang = heuristicLang(req.body?.message);
    return res.status(500).json({
      reply: lang === "es" ? "Tuve un problema técnico. Intenta de nuevo en un momento." : "I hit a technical snag. Please try again in a moment.",
      followup: "",
      error: "internal_error",
    });
  }
});

/* ===================== Start ===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor Remy v${BUILD_VERSION} en puerto ${PORT}`);
});
