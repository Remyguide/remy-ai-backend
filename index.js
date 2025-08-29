// index.js (v2)
// Remy backend — OSM + memoria ligera + mejor idioma + filtro cadenas

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { OpenAI } from "openai";
// Si usas Node < 18:
// import fetch from "node-fetch"; globalThis.fetch = fetch;

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ===== OSM / Nominatim =====
const NOMINATIM_EMAIL = process.env.NOMINATIM_EMAIL || "remy@example.com";
const USER_AGENT = "RemyBot/1.0 (" + NOMINATIM_EMAIL + ")";

// ===== Memoria por usuario =====
const SESSIONS = new Map();

function getSession(id) {
  if (!SESSIONS.has(id)) {
    SESSIONS.set(id, {
      slots: { city: "", zone: "", cuisine: "", budget: "" },
      lang: "es",
      history: [],
      lastUpdated: Date.now(),
    });
  }
  return SESSIONS.get(id);
}
function setSlots(id, updates = {}) {
  const s = getSession(id);
  s.slots = { ...s.slots, ...cleanSlots(updates) };
  s.lastUpdated = Date.now();
  SESSIONS.set(id, s);
  return s.slots;
}
function setLang(id, lang) {
  const s = getSession(id);
  s.lang = lang || s.lang || "es";
  s.lastUpdated = Date.now();
  SESSIONS.set(id, s);
  return s.lang;
}
function resetSession(id) {
  SESSIONS.set(id, {
    slots: { city: "", zone: "", cuisine: "", budget: "" },
    lang: "es",
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
  // budget a números
  if (out.budget && /\d/.test(out.budget)) {
    const m = String(out.budget).match(/\d{2,6}/);
    out.budget = m ? m[0] : "";
  } else out.budget = "";
  return out;
}

// ===== Idioma =====
function heuristicLang(str) {
  const s = (str || "").toLowerCase();
  const hasAccent = /[áéíóúñü¿¡]/.test(s);
  const esWords = /(hola|quiero|dame|estoy|ciudad|zona|presupuesto|antojo|buscar|recomienda|mexic|cdmx|guadalajara|monterrey)/i.test(
    s
  );
  if (hasAccent || esWords) return "es";
  return "en";
}
function chooseLang({ sessionLang, nluLang, msg }) {
  // preferimos NLU si viene, si no, sesión, si no heurística, default es
  return nluLang || sessionLang || heuristicLang(msg) || "es";
}

// ===== Próximo slot sugerido =====
function computeNextSlot(slots) {
  if (!slots.city) return "city";
  if (!slots.cuisine && !slots.zone) return "cuisine_or_zone";
  if (!slots.budget) return "budget";
  return "";
}

// ===== NLU (OpenAI) =====
async function extractNLU({ message, slots }) {
  const moneyMatch = message.match(/\$?\s?(\d{2,5})\s*(mxn|pesos)?/i);
  const budgetRegex = moneyMatch ? moneyMatch[1] : "";

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
- "en la zona de Y/cerca de Y" => updates.zone.
- "se me antoja/quiero X" => updates.cuisine.
- "$300, 300 pesos" => updates.budget números.
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
    if (!parsed?.updates?.budget && budgetRegex) parsed.updates.budget = budgetRegex;
    return parsed;
  } catch {
    return {
      updates: { budget: budgetRegex || "" },
      negations: { city_from: "" },
      intent: "unknown",
      language: "",
    };
  }
}

// ===== Geocoding (Nominatim) =====
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
  if (zone) {
    const z = await geocodePlace(`${zone}, ${city}`);
    if (z) return z;
  }
  return await geocodePlace(city);
}

// ===== Overpass (restaurantes) =====
const CHAIN_BLACKLIST = [
  /starbucks/i,
  /mcdonald/i,
  /burger\s*king|bk/i,
  /domino'?s/i,
  /little\s*caesars/i,
  /kfc/i,
  /vips/i,
  /sanborns/i,
  /toks/i,
  /sushi\s*roll/i,
  /wingstop|wings/i,
];

function isChain(name, tags = {}) {
  if (!name) return false;
  if (CHAIN_BLACKLIST.some((re) => re.test(name))) return true;
  if (tags.brand || tags["brand:wikidata"]) return true;
  return false;
}

function escapeOverpassRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

async function searchRestaurants({ lat, lon, radius = 3000, cuisine = "" }) {
  // Quitamos fast_food para subir calidad
  const cuisineFilter = cuisine ? `["cuisine"~"${escapeOverpassRegex(cuisine)}",i]` : "";
  const around = `around:${Math.max(500, Math.min(8000, radius))},${lat},${lon}`;

  const query = `
[out:json][timeout:25];
(
  node${cuisineFilter}["amenity"~"^(restaurant|cafe)$"]( ${around} );
  way${cuisineFilter}["amenity"~"^(restaurant|cafe)$"]( ${around} );
  relation${cuisineFilter}["amenity"~"^(restaurant|cafe)$"]( ${around} );
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

  const places = (data?.elements || [])
    .map((el) => {
      const tags = el.tags || {};
      const center = el.type === "node" ? { lat: el.lat, lon: el.lon } : el.center || null;
      const cuisines = (tags.cuisine || "").split(";").map((s) => s.trim()).filter(Boolean);
      const street = tags["addr:street"] || "";
      const housenumber = tags["addr:housenumber"] || "";
      const neighbourhood = tags["addr:neighbourhood"] || tags["addr:suburb"] || "";
      const city = tags["addr:city"] || "";
      const address = [street && `${street} ${housenumber}`.trim(), neighbourhood, city]
        .filter(Boolean)
        .join(", ");
      return {
        id: `${el.type}/${el.id}`,
        name: tags.name || "",
        amenity: tags.amenity || "",
        cuisines,
        address,
        lat: center?.lat || null,
        lon: center?.lon || null,
        tags,
      };
    })
    .filter((p) => p.name && !isChain(p.name, p.tags));

  // Preferimos que tenga cuisine y dirección
  const scored = dedupePlaces(places)
    .map((p) => ({
      ...p,
      score:
        (p.cuisines.length ? 3 : 0) +
        (p.address ? 2 : 0) +
        (p.amenity === "restaurant" ? 1 : 0),
    }))
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, 10);
}

// ===== Redacción =====
function craftReply({ lang = "es", slots, results }) {
  const { city, zone, cuisine, budget } = slots;
  const in_es = lang === "es";

  if (!results?.length) {
    const ask = !city
      ? in_es ? "¿En qué ciudad estás?" : "Which city are you in?"
      : !cuisine && !zone
      ? in_es
        ? "¿Se te antoja alguna cocina o prefieres que acote por zona?"
        : "Any cuisine you crave, or should I narrow by area?"
      : in_es
      ? "¿Quieres que pruebe con otra zona o cocina?"
      : "Want me to try a different area or cuisine?";
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
      const cuis = p.cuisines?.length ? ` (${p.cuisines.slice(0, 2).join(", ")})` : "";
      const addr = p.address ? ` — ${p.address}` : "";
      return `• ${p.name}${cuis}${addr}`;
    })
    .join("\n");

  const ctx = [city, zone].filter(Boolean).join(", ");
  const intro = in_es
    ? `Aquí van algunas opciones${cuisine ? ` de ${cuisine}` : ""}${ctx ? ` en ${ctx}` : ""}:`
    : `Here are some${cuisine ? ` ${cuisine}` : ""} options${ctx ? ` in ${ctx}` : ""}:`;

  const askNext = (() => {
    const nxt = computeNextSlot(slots);
    if (nxt === "cuisine_or_zone") {
      return in_es
        ? "¿Te late alguna cocina o prefiero acotar por zona?"
        : "Prefer a cuisine or should I narrow by area?";
    }
    if (nxt === "budget") {
      return in_es ? "¿Presupuesto aprox. por persona?" : "Approx budget per person?";
    }
    return in_es ? "¿Quieres otra opción o afino la búsqueda?" : "Want another option or a refined search?";
  })();

  const budgetNote = budget ? (in_es ? ` (tomé ~$${budget} MXN pp)` : ` (considering ~$${budget} MXN pp)`) : "";

  return {
    reply: `${intro}\n${bullet}${budgetNote}`,
    followup: askNext,
  };
}

// ===== Rutas =====
app.get("/", (_req, res) => res.send("remy-ai-backend up"));

app.post("/recommendation", async (req, res) => {
  const {
    message = "",
    username = "",
    manychat_user_id = "",
    preferred_lang = "", // <-- puedes mandarlo desde Manychat si quieres forzar "es"
    city = "",
    zone = "",
    cuisine = "",
    budget = "",
    slots: bodySlots = {},
  } = req.body || {};

  if (!manychat_user_id) return res.status(400).json({ error: "manychat_user_id is required" });

  try {
    // 1) Sesión + slots entrantes
    const incoming = cleanSlots({ city, zone, cuisine, budget, ...(bodySlots || {}) });
    let session = getSession(manychat_user_id);
    let slots = setSlots(manychat_user_id, incoming);

    // 2) NLU
    const nlu = await extractNLU({ message, slots });

    // 2.1) Idioma final
    const finalLang = chooseLang({
      sessionLang: preferred_lang || session.lang,
      nluLang: nlu.language,
      msg: message || username,
    });
    setLang(manychat_user_id, finalLang);

    // 2.2) Reset
    if (nlu.intent === "reset") {
      resetSession(manychat_user_id);
      return res.json({
        reply:
          finalLang === "es"
            ? "Listo, reinicié la conversación. ¿En qué ciudad estás y qué se te antoja?"
            : "Done, I reset the chat. Which city are you in and what are you craving?",
        followup: finalLang === "es" ? "¿Ciudad y antojo?" : "City and craving?",
        slots: { city: "", zone: "", cuisine: "", budget: "" },
        next_slot: "city",
      });
    }

    // 2.3) Negaciones (“ya no estoy en X”)
    if (nlu.negations?.city_from && slots.city) {
      if (slots.city.toLowerCase().includes(nlu.negations.city_from.toLowerCase())) {
        slots = setSlots(manychat_user_id, { city: "" });
      }
    }

    // 2.4) Aplica updates
    if (nlu.updates) slots = setSlots(manychat_user_id, nlu.updates);

    // 3) Si falta ciudad, pídele ciudad
    if (!slots.city) {
      return res.json({
        reply:
          finalLang === "es"
            ? "Para recomendar algo, dime en qué ciudad estás."
            : "To recommend something, tell me which city you're in.",
        followup: finalLang === "es" ? "¿En qué ciudad estás?" : "Which city are you in?",
        slots,
        next_slot: "city",
      });
    }

    // 4) Geocoding
    const place = await geocodeCityZone(slots.city, slots.zone);
    if (!place?.lat || !place?.lon) {
      return res.json({
        reply:
          finalLang === "es"
            ? `No pude ubicar ${slots.zone ? `${slots.zone}, ` : ""}${slots.city}.`
            : `I couldn't locate ${slots.zone ? `${slots.zone}, ` : ""}${slots.city}.`,
        followup:
          finalLang === "es"
            ? "¿Podrías escribirlo distinto o darme un punto de referencia?"
            : "Could you phrase it differently or give me a nearby landmark?",
        slots,
        next_slot: "zone",
      });
    }

    // 5) Búsqueda de lugares
    const results = await searchRestaurants({
      lat: parseFloat(place.lat),
      lon: parseFloat(place.lon),
      radius: 3000,
      cuisine: slots.cuisine,
    });

    // 6) Redacción
    const { reply, followup } = craftReply({
      lang: finalLang,
      slots,
      results,
    });

    // 7) Devolver
    return res.json({
      reply,
      followup,
      slots,
      next_slot: computeNextSlot(slots),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Error generating recommendation", details: String(err?.message || err) });
  }
});

// ===== Server =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});

