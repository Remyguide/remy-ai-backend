// index.js — Remy v2.5
// - Auto-idioma por mensaje del usuario (ES/EN).
// - Sin bloqueos de cadenas: enfoque POSITIVO a alta cocina y buen street food.
// - OSM/Overpass (sin Google). Siempre intenta recomendar.

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

const BUILD_VERSION = "2.5.0";
app.get("/", (_req, res) => res.send(`remy-ai-backend up v${BUILD_VERSION}`));

// ========= Memoria simple =========
const SESSIONS = new Map();
function getSession(id) {
  if (!SESSIONS.has(id)) {
    SESSIONS.set(id, {
      slots: { city: "", zone: "", cuisine: "", budget: "" },
      history: [],
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
    history: [],
    lastUpdated: Date.now(),
  });
}
function nextSlot(slots) {
  if (!slots.city) return "city";
  if (!slots.cuisine && !slots.zone) return "cuisine_or_zone";
  if (!slots.budget) return "budget";
  return "";
}

// ========= Idioma =========
function heuristicLang(str) {
  const s = (str || "").toLowerCase();
  if (/[áéíóúñü¿¡]/.test(s)) return "es";
  if (/(hola|quiero|estoy|ciudad|zona|presupuesto|antojo|buscar|recomienda|méxico|cdmx|guadalajara|monterrey|tacos|taquería|taqueria)/i.test(
    s
  ))
    return "es";
  return "en";
}
function pickLang({ msg, nluLang }) {
  return nluLang || heuristicLang(msg) || "es";
}

// ========= NLU =========
async function extractNLU({ message, slots }) {
  const sys = `Devuelve SOLO JSON:
{
  "updates": { "city": "", "zone": "", "cuisine": "", "budget": "" },
  "negations": { "city_from": "" },
  "intent": "recommend|update|reset|chitchat|unknown",
  "language": "es|en"
}
Reglas:
- "olvida todo", "reset", "empecemos de nuevo" => intent="reset".
- "ya no estoy en X" => negations.city_from = "X".
- "estoy en/ahora en X" => updates.city.
- "en la zona de Y/cerca de Y/por Y" => updates.zone.
- "se me antoja/quiero X" => updates.cuisine.
- "$300, 300 pesos" => updates.budget numérica.
- language = idioma del MENSAJE (es/en).`;

  const user = `Mensaje: """${message}"""
Slots previos: ${JSON.stringify(slots)}`;

  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
    });
    const raw = r.choices?.[0]?.message?.content?.trim() || "{}";
    const parsed = JSON.parse(raw);
    if (!parsed?.updates?.budget) {
      const m = message.match(/\$?\s?(\d{2,5})\s*(mxn|pesos)?/i);
      if (m) parsed.updates.budget = m[1];
    }
    return parsed;
  } catch {
    return {
      updates: {},
      negations: { city_from: "" },
      intent: "unknown",
      language: heuristicLang(message),
    };
  }
}

// ========= OSM / Nominatim / Overpass =========
const NOMINATIM_EMAIL = process.env.NOMINATIM_EMAIL || "remy@example.com";
const UA = `RemyBot/${BUILD_VERSION} (${NOMINATIM_EMAIL})`;

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
  if (zone) {
    const z = await geocodePlace(`${zone}, ${city}`);
    if (z) return z;
  }
  return await geocodePlace(city);
}

// Penalización SUAVE (no bloqueo) si parece cadena
const CHAIN_HINT = [
  /vips/i, /sanborns/i, /toks/i, /starbucks/i, /mcdonald/i, /burger\s*king|bk/i,
  /kfc/i, /carls?\s*jr/i, /domino'?s/i, /pizza\s*hutm?/i, /little\s*caesars/i,
  /papa\s*john'?s/i, /sushi\s*roll/i, /wingstop|wings/i, /chili'?s/i, /applebee'?s/i,
  /olive\s*garden/i, /ihop/i, /cheesecake\s*factory/i, /dennys/i, /hooters/i,
  /taco\s*bell/i, /subway/i
];
function chainPenalty(name, tags = {}) {
  if (!name) return 0;
  if (tags.brand || tags["brand:wikidata"]) return -2;
  return CHAIN_HINT.some((re) => re.test(name)) ? -2 : 0;
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
  /omakase/i, /kaiseki/i, /chef/i, /tasting/i, /degustación|degustacion/i,
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

async function searchRestaurants({ lat, lon, radius = 3000, cuisine = "", includeFastFood = false }) {
  const cuisineFilter = cuisine ? `["cuisine"~"${esc(cuisine)}",i]` : "";
  const around = `around:${Math.max(600, Math.min(6000, radius))},${lat},${lon}`;

  // Incluimos restaurant, cafe y (opcional) fast_food para buen street food
  const fast = includeFastFood ? '|fast_food' : '';
  const query = `
[out:json][timeout:30];
(
  node${cuisineFilter}["amenity"~"^(restaurant|cafe${fast})$"](${around});
  way${cuisineFilter}["amenity"~"^(restaurant|cafe${fast})$"](${around});
  relation${cuisineFilter}["amenity"~"^(restaurant|cafe${fast})$"](${around});
);
out center tags 60;`;

  const r = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": UA,
    },
    body: new URLSearchParams({ data: query }).toString(),
  });
  if (!r.ok) throw new Error("Overpass " + r.status);
  const data = await r.json();

  const places = (data?.elements || []).map((el) => {
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
      // Base positivos
      if (p.cuisines.length) score += 3;
      if (p.address) score += 2;
      if (p.amenity === "restaurant") score += 1;
      if (p.hasContact) score += 2;

      // Coincidencia con antojo
      if (cuisine) {
        const match = p.cuisines.some((c) => new RegExp(esc(cuisine), "i").test(c));
        if (match) score += 2;
      }

      // Fine dining hints
      score += fineDiningBoostByName(p.name);

      // Street food: si el usuario pidió tacos/birria/etc., favorece fast_food locales
      if (streetWanted && p.amenity === "fast_food") score += 2;

      // Penalización SUAVE si parece cadena (no excluye)
      score += chainPenalty(p.name, p.tags);

      return { ...p, score };
    })
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, 12);
}

// ========= Redacción =========
function craftReply({ lang = "es", slots, results }) {
  const { city, zone, cuisine, budget } = slots;
  const es = lang === "es";

  if (!results?.length) {
    const ask = !city
      ? es ? "¿En qué ciudad estás?" : "Which city are you in?"
      : !cuisine && !zone
      ? es ? "¿Se te antoja alguna cocina o prefieres acotar por zona?" : "Any cuisine you crave, or should I narrow by area?"
      : es ? "¿Quieres que pruebe con otra zona o cocina?" : "Want me to try a different area or cuisine?";
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
  let askNext = es ? "¿Quieres otra opción o afino la búsqueda?" : "Want another option or a tighter search?";
  if (nxt === "cuisine_or_zone") {
    askNext = es ? "¿Te late alguna cocina o prefieres que acote por zona?" : "Prefer a cuisine or should I narrow by area?";
  } else if (nxt === "budget") {
    askNext = es ? "¿Presupuesto aprox. por persona?" : "Approx budget per person?";
  }

  const budgetNote = budget ? (es ? ` (consideré ~$${budget} MXN pp)` : ` (considered ~$${budget} MXN pp)`) : "";

  return {
    reply: `${intro}\n${bullet}${budgetNote}`,
    followup: askNext,
  };
}

// ========= Endpoint principal =========
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
    let session = getSession(manychat_user_id);
    let slots = setSlots(manychat_user_id, { city, zone, cuisine, budget, ...(bodySlots || {}) });

    const nlu = await extractNLU({ message, slots });

    if (nlu.intent === "reset") {
      resetSession(manychat_user_id);
      return res.json({
        reply:
          pickLang({ msg: message, nluLang: nlu.language }) === "es"
            ? "Listo, reinicié la conversación. ¿En qué ciudad estás y qué se te antoja?"
            : "Done, I reset the chat. Which city are you in and what are you craving?",
        followup: pickLang({ msg: message, nluLang: nlu.language }) === "es" ? "¿Ciudad y antojo?" : "City and craving?",
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

    const lang = pickLang({ msg: message || username, nluLang: nlu.language });

    if (!slots.city) {
      return res.json({
        reply: lang === "es" ? "Para recomendar algo, dime en qué ciudad estás." : "To recommend something, tell me which city you're in.",
        followup: lang === "es" ? "¿En qué ciudad estás?" : "Which city are you in?",
        slots,
        next_slot: "city",
      });
    }

    const place = await geocodeCityZone(slots.city, slots.zone);
    if (!place?.lat || !place?.lon) {
      return res.json({
        reply:
          lang === "es"
            ? `No pude ubicar ${slots.zone ? `${slots.zone}, ` : ""}${slots.city}.`
            : `I couldn't locate ${slots.zone ? `${slots.zone}, ` : ""}${slots.city}.`,
        followup:
          lang === "es"
            ? "¿Podrías escribirlo distinto o darme un punto de referencia?"
            : "Could you phrase it differently or give me a nearby landmark?",
        slots,
        next_slot: "zone",
      });
    }

    // Radio según si hay zona y si parece street food
    const streetWanted = wantStreetFood(slots.cuisine);
    const radius = slots.zone ? 1500 : streetWanted ? 2500 : 3500;

    const results = await searchRestaurants({
      lat: parseFloat(place.lat),
      lon: parseFloat(place.lon),
      radius,
      cuisine: slots.cuisine,
      includeFastFood: streetWanted, // solo lo incluimos si pinta a street food
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
    return res.status(500).json({
      reply:
        heuristicLang(req.body?.message) === "es"
          ? "Tuve un problema técnico. Intenta de nuevo en un momento."
          : "I hit a technical snag. Please try again in a moment.",
      followup: "",
      error: "internal_error",
    });
  }
});

// ========= Arranque =========
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor Remy v${BUILD_VERSION} en puerto ${PORT}`);
});
