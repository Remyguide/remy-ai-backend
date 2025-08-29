// index.js
// Remy backend — restaurantes con memoria ligera y OSM (sin Google Places)

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { OpenAI } from "openai";
// Si NO estás en Node 18+, descomenta las 2 líneas siguientes y `npm i node-fetch`:
// import fetch from "node-fetch";
// globalThis.fetch = fetch;

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ====== Config OSM/Nominatim ======
// Pon un email real para cumplir la política de Nominatim (opcional pero recomendado)
const NOMINATIM_EMAIL = process.env.NOMINATIM_EMAIL || "remy@example.com";
const USER_AGENT = "RemyBot/1.0 (contact: " + NOMINATIM_EMAIL + ")";

// ====== Memoria en RAM por usuario ======
const SESSIONS = new Map();

function getSession(userId) {
  if (!SESSIONS.has(userId)) {
    SESSIONS.set(userId, {
      slots: { city: "", zone: "", cuisine: "", budget: "" },
      history: [],
      lastUpdated: Date.now(),
    });
  }
  return SESSIONS.get(userId);
}

function setSlots(userId, updates = {}) {
  const s = getSession(userId);
  s.slots = { ...s.slots, ...cleanSlots(updates) };
  s.lastUpdated = Date.now();
  SESSIONS.set(userId, s);
  return s.slots;
}

function resetSession(userId) {
  SESSIONS.set(userId, {
    slots: { city: "", zone: "", cuisine: "", budget: "" },
    history: [],
    lastUpdated: Date.now(),
  });
}

function cleanSlots(slots) {
  const norm = (v) => (typeof v === "string" ? v.trim() : v || "");
  const out = {
    city: norm(slots.city),
    zone: norm(slots.zone),
    cuisine: norm(slots.cuisine),
    budget: norm(slots.budget),
  };
  // Solo números en budget
  if (out.budget && /\d/.test(out.budget)) {
    const m = String(out.budget).match(/\d{2,6}/);
    out.budget = m ? m[0] : "";
  } else {
    out.budget = "";
  }
  return out;
}

// ====== Util ======
function detectLang(str) {
  // heurística simple
  return /[áéíóúñü¿¡]/i.test(str) ? "es" : "en";
}

function computeNextSlot(slots) {
  if (!slots.city) return "city";
  // Con ciudad ya recomendamos, pero lo más útil para afinar:
  if (!slots.cuisine && !slots.zone) return "cuisine_or_zone";
  if (!slots.budget) return "budget";
  return ""; // ya tenemos suficiente
}

// ====== NLU ligero: extrae city/zone/cuisine/budget/intención ======
async function extractNLU({ message, lang = "es", slots = {} }) {
  // Presupuesto rápido por regex (e.g. "$200", "200 pesos")
  const moneyMatch = message.match(/\$?\s?(\d{2,5})\s*(mxn|pesos)?/i);
  const budgetRegex = moneyMatch ? moneyMatch[1] : "";

  const sys = `Devuelve SOLO JSON válido con esta forma exacta:
{
  "updates": { "city": "", "zone": "", "cuisine": "", "budget": "" },
  "negations": { "city_from": "" },
  "intent": "recommend|update|reset|chitchat|unknown",
  "language": "es|en"
}
Reglas:
- "ya no estoy en X", "me fui de X" => negations.city_from = "X".
- "ahora en Monterrey", "estoy en CDMX" => updates.city = "Monterrey"/"Ciudad de México".
- "en la zona de San Pedro", "cerca de Chapultepec" => updates.zone.
- "se me antoja ramen/pizza/italiano", "quiero tacos" => updates.cuisine.
- "$300", "200 pesos" => updates.budget (solo números).
- Si detectas reinicio (olvida, reset, empecemos), intent = "reset".
- language = idioma del usuario.
- Si no estás seguro, deja campos vacíos.`;

  const user = `Mensaje: """${message}"""
Slots previos: ${JSON.stringify(slots)}`;

  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
    });
    const raw = resp.choices?.[0]?.message?.content?.trim() || "{}";
    const parsed = JSON.parse(raw);
    // Fusión con regex de presupuesto (por si el LLM no lo captó)
    if (!parsed?.updates?.budget && budgetRegex) parsed.updates.budget = budgetRegex;
    return parsed;
  } catch {
    return {
      updates: { budget: budgetRegex || "" },
      negations: { city_from: "" },
      intent: "unknown",
      language: lang,
    };
  }
}

// ====== OSM: Geocoding (Nominatim) ======
async function geocodePlace(q) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", q);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", "1");
  url.searchParams.set("email", NOMINATIM_EMAIL);

  const r = await fetch(url.toString(), {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!r.ok) throw new Error("Nominatim error " + r.status);
  const arr = await r.json();
  return arr?.[0] || null;
}

async function geocodeCityZone(city, zone) {
  if (!city) return null;
  // Primero: buscar "zone, city"
  if (zone) {
    const z = await geocodePlace(`${zone}, ${city}`);
    if (z) return z; // centrarse en la zona
  }
  // Fallback: ciudad
  return await geocodePlace(city);
}

// ====== OSM: Overpass para restaurantes ======
async function searchRestaurants({ lat, lon, radius = 3000, cuisine = "" }) {
  // Overpass QL
  // Busca amenity=restaurant|fast_food|cafe dentro de radio
  // Filtra por cuisine si viene.
  const amenity = '(node["amenity"~"^(restaurant|fast_food|cafe)$"];way["amenity"~"^(restaurant|fast_food|cafe)$"];relation["amenity"~"^(restaurant|fast_food|cafe)$"];);';
  const cuisineFilter = cuisine
    ? `["cuisine"~"${escapeOverpassRegex(cuisine)}",i]`
    : "";
  const around = `around:${Math.max(500, Math.min(8000, radius))},${lat},${lon}`;

  const query = `
[out:json][timeout:25];
(
  node${cuisineFilter}${amenity.includes("node") ? '["amenity"]' : ""}( ${around} );
  way${cuisineFilter}["amenity"]( ${around} );
  relation${cuisineFilter}["amenity"]( ${around} );
);
out center tags 60;
`;

  const r = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: new URLSearchParams({ data: query }).toString(),
  });

  if (!r.ok) throw new Error("Overpass error " + r.status);
  const data = await r.json();
  const elements = data?.elements || [];
  // Normaliza
  const places = elements
    .map((el) => {
      const tags = el.tags || {};
      const name = tags.name || "";
      const cuisines = (tags.cuisine || "").split(";").map((s) => s.trim()).filter(Boolean);
      // Dirección breve
      const street = tags["addr:street"] || "";
      const housenumber = tags["addr:housenumber"] || "";
      const neighbourhood = tags["addr:neighbourhood"] || tags["addr:suburb"] || "";
      const city = tags["addr:city"] || "";
      const address = [street && `${street} ${housenumber}`.trim(), neighbourhood, city]
        .filter(Boolean)
        .join(", ");
      const center = el.type === "node"
        ? { lat: el.lat, lon: el.lon }
        : el.center || null;

      return {
        id: `${el.type}/${el.id}`,
        name,
        amenity: tags.amenity || "",
        cuisines,
        address,
        lat: center?.lat || null,
        lon: center?.lon || null,
        tags,
      };
    })
    .filter((p) => p.name); // exige nombre

  // Dedupe por nombre + proximidad
  const deduped = dedupePlaces(places);
  // Orden naive: si hay cuisine pedida, prioriza coincidencia
  const scored = deduped
    .map((p) => ({
      ...p,
      score:
        (cuisine && p.cuisines.some((c) => eqCuisine(c, cuisine)) ? 10 : 0) +
        (p.amenity === "restaurant" ? 2 : 0),
    }))
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, 10); // tope 10, luego redactamos 2-3
}

function escapeOverpassRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function eqCuisine(a, b) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
function dedupePlaces(arr) {
  const seen = new Map();
  const out = [];
  for (const p of arr) {
    const key = (p.name + "|" + (p.address || "")).toLowerCase();
    if (!seen.has(key)) {
      seen.set(key, true);
      out.push(p);
    }
  }
  return out;
}

// ====== Redacción determinística (sin LLM) ======
function craftReply({ lang = "es", slots, results }) {
  const { city, zone, cuisine, budget } = slots;
  const in_es = lang === "es";

  if (!results?.length) {
    const ask =
      !city
        ? (in_es ? "¿En qué ciudad estás?" : "Which city are you in?")
        : (!cuisine && !zone
            ? (in_es
                ? "¿Se te antoja alguna cocina o zona en particular?"
                : "Any cuisine or area in mind?")
            : (in_es ? "¿Quieres que busque en otra zona o con otro antojo?" : "Want me to try a different area or cuisine?"));
    return {
      reply: in_es
        ? `No encontré lugares con esos criterios ${city ? `en ${city}` : ""}.`
        : `I couldn't find places with those criteria ${city ? `in ${city}` : ""}.`,
      followup: ask,
    };
  }

  const top = results.slice(0, 3);
  const bullet = top
    .map((p) => {
      const addr = p.address ? ` — ${p.address}` : "";
      const cuis = p.cuisines?.length ? ` (${p.cuisines.slice(0,2).join(", ")})` : "";
      return `• ${p.name}${cuis}${addr}`;
    })
    .join("\n");

  const ctxPieces = [];
  if (city) ctxPieces.push(city);
  if (zone) ctxPieces.push(zone);
  const ctx = ctxPieces.length ? (in_es ? `en ${ctxPieces.join(", ")}` : `in ${ctxPieces.join(", ")}`) : "";

  const intro = in_es
    ? (cuisine ? `Aquí van algunas opciones de ${cuisine} ${ctx}:` : `Aquí van algunas opciones ${ctx}:`)
    : (cuisine ? `Here are a few ${cuisine} options ${ctx}:` : `Here are a few options ${ctx}:`);

  const ask = (() => {
    const nxt = computeNextSlot(slots);
    if (nxt === "cuisine_or_zone") {
      return in_es
        ? "¿Te late alguna cocina o prefieres que enfoque por zona?"
        : "Do you prefer a specific cuisine or should I focus on an area?";
    }
    if (nxt === "budget") {
      return in_es
        ? "¿Tienes un presupuesto por persona aproximado?"
        : "Do you have an approximate budget per person?";
    }
    return in_es
      ? "¿Quieres que te dé otra opción o afino por zona/presupuesto?"
      : "Want another option or should I refine by area/budget?";
  })();

  const budgetLine =
    budget && Number(budget) > 0
      ? (in_es ? ` (tomé en cuenta ~$${budget} MXN pp)` : ` (considering ~$${budget} MXN pp)`)
      : "";

  return {
    reply: `${intro}\n${bullet}${budgetLine}`,
    followup: ask,
  };
}

// ====== Endpoint ======
app.get("/", (_req, res) => res.send("remy-ai-backend up"));

app.post("/recommendation", async (req, res) => {
  const {
    message = "",
    username = "",
    manychat_user_id = "",
    // Permite que Manychat mande slots planos o anidados
    city = "",
    zone = "",
    cuisine = "",
    budget = "",
    slots: bodySlots = {},
  } = req.body || {};

  if (!manychat_user_id) {
    return res.status(400).json({ error: "manychat_user_id is required" });
  }

  try {
    // 1) Carga sesión + aplica slots entrantes (de Manychat)
    const incomingSlots = cleanSlots({ city, zone, cuisine, budget, ...(bodySlots || {}) });
    let session = getSession(manychat_user_id);
    let slots = setSlots(manychat_user_id, incomingSlots);
    const lang = detectLang(message || username || JSON.stringify(slots) || "");

    // 2) NLU del mensaje
    const nlu = await extractNLU({ message, lang, slots });

    // 2.1) Reset
    if (nlu.intent === "reset") {
      resetSession(manychat_user_id);
      return res.json({
        reply:
          lang === "es"
            ? "Listo, reinicié la charla. ¿En qué ciudad estás y qué se te antoja?"
            : "Done, I reset the chat. Which city are you in and what are you craving?",
        followup: lang === "es" ? "¿Ciudad y antojo?" : "City and craving?",
        slots: { city: "", zone: "", cuisine: "", budget: "" },
        next_slot: "city",
      });
    }

    // 2.2) Negaciones: “ya no estoy en X”
    if (nlu.negations?.city_from && slots.city) {
      if (slots.city.toLowerCase().includes(nlu.negations.city_from.toLowerCase())) {
        slots = setSlots(manychat_user_id, { city: "" });
      }
    }

    // 2.3) Aplica updates detectados por NLU
    if (nlu.updates) {
      slots = setSlots(manychat_user_id, nlu.updates);
    }

    // 3) ¿Podemos recomendar con lo que hay?
    const canRecommend = !!slots.city; // con ciudad basta

    // 4) Si no hay ciudad, pide ciudad
    if (!canRecommend) {
      const reply =
        lang === "es"
          ? "Para recomendar algo, dime en qué ciudad estás."
          : "To recommend something, tell me which city you're in.";
      const followup = lang === "es" ? "¿En qué ciudad estás?" : "Which city are you in?";
      return res.json({
        reply,
        followup,
        slots,
        next_slot: "city",
      });
    }

    // 5) Geocodificar ciudad/zona
    const place = await geocodeCityZone(slots.city, slots.zone);
    if (!place?.lat || !place?.lon) {
      const reply =
        lang === "es"
          ? `No pude ubicar ${slots.zone ? `${slots.zone}, ` : ""}${slots.city}.`
          : `I couldn't locate ${slots.zone ? `${slots.zone}, ` : ""}${slots.city}.`;
      const followup =
        lang === "es"
          ? "¿Podrías escribirlo de otra forma o darme una referencia cercana?"
          : "Could you phrase it differently or give me a nearby landmark?";
      return res.json({
        reply,
        followup,
        slots,
        next_slot: "zone",
      });
    }

    // 6) Buscar restaurantes cercano al centro devuelto
    const center = { lat: parseFloat(place.lat), lon: parseFloat(place.lon) };
    const results = await searchRestaurants({
      lat: center.lat,
      lon: center.lon,
      radius: 3000,
      cuisine: slots.cuisine,
    });

    // 7) Redactar respuesta
    const { reply, followup } = craftReply({
      lang: nlu.language || lang,
      slots,
      results,
    });

    // 8) Siguiente slot recomendado
    const next_slot = computeNextSlot(slots);

    // 9) Responder a Manychat
    return res.json({
      reply,
      followup,
      slots,
      next_slot,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: "Error generating recommendation",
      details: String(err?.message || err),
    });
  }
});

// ====== Server ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
