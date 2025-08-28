// index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { OpenAI } from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ====== Memoria y caché en RAM ======
const SESSIONS = new Map(); // { userId: { slots, ts } }
const PLACES_CACHE = new Map(); // key -> { data, ts }
const CACHE_TTL_MS = 1000 * 60 * 60 * 12; // 12h
const SESSION_TTL_MS = 1000 * 60 * 60 * 2; // 2h

const UA = "RemyGuide/1.0 (+contact: your-email@example.com)";

// Util
const now = () => Date.now();
const cleanExpired = () => {
  for (const [k, v] of SESSIONS.entries()) if (now() - v.ts > SESSION_TTL_MS) SESSIONS.delete(k);
  for (const [k, v] of PLACES_CACHE.entries()) if (now() - v.ts > CACHE_TTL_MS) PLACES_CACHE.delete(k);
};
setInterval(cleanExpired, 60_000).unref();

const getSession = (id) => {
  let s = SESSIONS.get(id);
  if (!s) {
    s = { slots: { city: "", zone: "", cuisine: "", budget: "" }, ts: now() };
    SESSIONS.set(id, s);
  } else {
    s.ts = now();
  }
  return s;
};

const setSlots = (id, partial) => {
  const s = getSession(id);
  s.slots = { ...s.slots, ...Object.fromEntries(Object.entries(partial || {}).filter(([_, v]) => !!v)) };
  return s.slots;
};

// ====== OpenStreetMap helpers (sin Google) ======
async function geocodeCity(city) {
  if (!city) return null;
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&addressdetails=1&q=${encodeURIComponent(
    city
  )}`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) return null;
  const arr = await res.json();
  if (!arr?.length) return null;
  const item = arr[0];
  return {
    lat: parseFloat(item.lat),
    lon: parseFloat(item.lon),
    display_name: item.display_name,
    boundingbox: item.boundingbox?.map((n) => parseFloat(n)) || null, // [south, north, west, east]
  };
}

// Construye consulta Overpass; filtra por cuisine y (opcional) zona
function buildOverpassQuery({ cityAreaName, cuisineRegex }) {
  // Buscamos el área administrativa por nombre de ciudad y luego restaurantes dentro.
  // Filtramos por cuisine (si hay).
  // Nota: OSM usa tags de 'cuisine' variados; usamos regex flexible.
  return `
[out:json][timeout:25];
area["boundary"="administrative"]["name"="${cityAreaName}"]->.a;
(
  node["amenity"="restaurant"${cuisineRegex ? `]["cuisine"~"${cuisineRegex}", i]` : ""}](area.a);
  way["amenity"="restaurant"${cuisineRegex ? `]["cuisine"~"${cuisineRegex}", i]` : ""}](area.a);
  relation["amenity"="restaurant"${cuisineRegex ? `]["cuisine"~"${cuisineRegex}", i]` : ""}](area.a);
);
out center tags 60;
`;
}

function cuisineToRegex(cuisine) {
  if (!cuisine) return "";
  const c = cuisine.toLowerCase().trim();
  // mapear términos comunes a etiquetas OSM
  const map = {
    tacos: "taco|mexican",
    mexicana: "mexican",
    italiano: "italian|pizza|pasta",
    pizza: "pizza|italian",
    sushi: "sushi|japanese",
    ramen: "ramen|japanese",
    japonés: "japanese|sushi|ramen",
    chinese: "chinese",
    vegano: "vegan|vegetarian",
    mariscos: "seafood|fish",
  };
  for (const [k, v] of Object.entries(map)) if (c.includes(k)) return v;
  // fallback: la palabra tal cual
  return c.replace(/[^\p{L}\p{N}]+/gu, "|");
}

async function searchOSM({ city, cuisine, zone }) {
  if (!city) return [];
  const key = JSON.stringify({ city, cuisine, zone });
  const hit = PLACES_CACHE.get(key);
  if (hit && now() - hit.ts < CACHE_TTL_MS) return hit.data;

  const cuisineRegex = cuisineToRegex(cuisine);
  const q = buildOverpassQuery({ cityAreaName: city, cuisineRegex });
  const res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "text/plain", "User-Agent": UA },
    body: q,
  });
  if (!res.ok) return [];
  const data = await res.json();

  let items =
    data?.elements?.map((e) => {
      const t = e.tags || {};
      const name = t.name || "";
      const addr = [
        t["addr:street"],
        t["addr:housenumber"],
        t["addr:neighbourhood"] || t["addr:suburb"] || t.suburb,
        t["addr:city"] || t.city,
      ]
        .filter(Boolean)
        .join(" ");
      const cuisine = t.cuisine || "";
      const center = e.center || { lat: e.lat, lon: e.lon };
      return {
        name,
        address: addr,
        cuisine,
        lat: center?.lat,
        lon: center?.lon,
        suburb: t["addr:suburb"] || t["addr:neighbourhood"] || "",
      };
    }) || [];

  // Si el usuario dio zona, priorizamos coincidencias por suburb/neighbourhood
  if (zone) {
    const z = zone.toLowerCase();
    items = items.sort((a, b) => {
      const av = a.suburb?.toLowerCase()?.includes(z) ? 1 : 0;
      const bv = b.suburb?.toLowerCase()?.includes(z) ? 1 : 0;
      return bv - av;
    });
  }

  // limpiamos, quitamos sin nombre
  items = items.filter((x) => x.name).slice(0, 30);

  PLACES_CACHE.set(key, { data: items, ts: now() });
  return items;
}

// ====== LLM: redacción amigable con los lugares hallados ======
async function craftReply({ lang, username, slots, places }) {
  const list = places
    .slice(0, 6)
    .map(
      (p, i) =>
        `${i + 1}. ${p.name}${p.address ? ` — ${p.address}` : ""}${p.suburb ? ` (${p.suburb})` : ""}`
    )
    .join("\n");

  const sys = `Eres Remy, un experto en restaurantes. Responde SIEMPRE en el mismo idioma del usuario (${lang}).
Cuando te doy una lista "PLACES", son lugares reales de OpenStreetMap. 
- Entrega 2–3 mejores opciones con nombre real y 1 línea de por qué.
- Incluye dirección breve si está disponible.
- Si faltan datos (ciudad/antojo/presupuesto), igual recomienda; luego haz 1 pregunta de seguimiento clara (no más de 1).
- No inventes teléfonos ni webs.`;

  const user = `Usuario: ${username || "invitado"}
Slots: ${JSON.stringify(slots)}
PLACES:
${list || "(sin resultados; sugiere zonas o estilos populares en la ciudad)"}  
Escribe una respuesta útil y breve. Luego una pregunta de seguimiento para continuar. Devuelve SOLO JSON:
{
  "reply": "<texto para enviar>",
  "followup": "<pregunta>",
  "slots": { "city": "", "zone": "", "cuisine": "", "budget": "" }
}`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.6,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
  });

  let content = completion.choices?.[0]?.message?.content?.trim() || "";
  try {
    return JSON.parse(content);
  } catch {
    const m = content.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {}
    }
  }
  return {
    reply:
      "Puedo sugerirte lugares por antojo, zona y presupuesto. ¿En qué ciudad estás y qué se te antoja?",
    followup: "¿En qué ciudad estás ahora?",
    slots,
  };
}

// ====== Reset intents simples ======
const RESET_PATTERNS = [
  "olvida todo",
  "empecemos de nuevo",
  "reset",
  "reinicia",
  "borrar conversación",
];

// ====== Endpoint ======
app.get("/", (_req, res) => res.send("remy-ai-backend up"));

app.post("/recommendation", async (req, res) => {
  try {
    const {
      message = "",
      username = "",
      manychat_user_id = "",
      slots: incomingSlots = {},
      pending_slot = "",
    } = req.body || {};

    const lang = /[áéíóúñ]/i.test(message) ? "es" : "en";

    // Reset rápido
    if (RESET_PATTERNS.some((p) => message.toLowerCase().includes(p))) {
      SESSIONS.delete(manychat_user_id);
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

    // Fusionar slots: primero sesión, luego lo que venga de ManyChat
    const session = getSession(manychat_user_id);
    const slots = setSlots(manychat_user_id, incomingSlots);

    // Si usuario respondió justo el pending_slot, úsalo
    const applyPending = (slotName) => {
      if (!slotName) return;
      if (!slots[slotName]) {
        // heurística barata: si el mensaje es corto, úsalo tal cual
        if (message && message.length <= 60) slots[slotName] = message.trim();
      }
    };
    applyPending(pending_slot);

    // Condición mínima para “aventarnos”: tener al menos city y (cuisine o zona)
    const canRecommend = !!slots.city && (!!slots.cuisine || !!slots.zone);

    // Buscar lugares reales si podemos
    let places = [];
    if (canRecommend) {
      places = await searchOSM({
        city: String(slots.city || "").trim(),
        cuisine: String(slots.cuisine || "").trim(),
        zone: String(slots.zone || "").trim(),
      });
    }

    // Redacción final con LLM (usa PLACES si existen)
    const out = await craftReply({
      lang,
      username,
      slots,
      places,
    });

    // Aseguramos estructura y next_slot (si faltan datos)
    const needCity = !slots.city;
    const needCuisine = !slots.cuisine;
    const needBudget = !slots.budget;

    let next_slot = "";
    if (!canRecommend) {
      if (needCity) next_slot = "city";
      else if (needCuisine) next_slot = "cuisine";
      else if (needBudget) next_slot = "budget"; // opcional
    }

    // Guardamos slots devueltos por el modelo también
    setSlots(manychat_user_id, out.slots);

    return res.json({
      reply: out.reply,
      followup: out.followup,
      slots: { ...slots, ...out.slots },
      next_slot,
    });
  } catch (err) {
    console.error(err);
    return res.status(200).json({
      reply:
        "Tuve un problema al buscar lugares ahora mismo. Puedo sugerirte por zona y antojo. ¿Dónde estás y qué se te antoja?",
      followup: "¿Ciudad y antojo?",
      slots: { city: "", zone: "", cuisine: "", budget: "" },
      next_slot: "city",
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));

