// Remy "Chef" Backend — v5.1 (fluido, tolerante y con base canónica)
// - Slots con "awaitSlot": entiende respuestas cortas (p.ej. "Salamanca")
// - Idioma estable, regex de ciudad flexible, normalización de CDMX
// - Prioriza base canónica (db.js) y cae a Overpass como fallback
// - Badges: Michelin/50Best/La Liste/Green

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { findTopByPrestige } from "./db.js"; // ⬅️ tu base canónica primero

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const BUILD = "5.1.0";

// -------------------- Sesiones muy simples (en memoria) --------------------
const SESS = new Map();
function sess(id) {
  if (!SESS.has(id)) {
    SESS.set(id, {
      lang: "es",
      slots: { city: "", zone: "", cuisine: "", budget: "" },
      lastIntent: "",
      lastResults: [],
      awaitSlot: "",        // ⬅️ qué slot estamos esperando (city/zone/cuisine/budget)
      updatedAt: Date.now(),
    });
  }
  return SESS.get(id);
}
const norm = (v) =>
  (typeof v === "string" ? v.trim().replace(/^[\s,.;:!?]+|[\s,.;:!?]+$/g, "") : "");

function setSlots(s, upd = {}) {
  const next = { ...s.slots, ...upd };
  let budget = norm(next.budget);
  if (budget) {
    const m = String(budget).match(/\d{2,6}/);
    budget = m ? m[0] : "";
  }
  s.slots = {
    city: norm(next.city),
    zone: norm(next.zone),
    cuisine: norm(next.cuisine),
    budget,
  };
}
function resetSession(s) {
  s.slots = { city: "", zone: "", cuisine: "", budget: "" };
  s.lastIntent = "";
  s.lastResults = [];
  s.awaitSlot = "";
}

// -------------------- Idioma por mensaje (estable) --------------------
function detectLang(text = "") {
  const t = text.toLowerCase();
  if (/(méxico|mexico|cdmx|ciudad\s+de\s+m[eé]xico)/i.test(t)) return "es";
  if (/[áéíóúñü¿¡]/.test(t)) return "es";
  if (/(hola|buenas|ciudad|zona|antojo|presupuesto)/i.test(t)) return "es";
  return "en";
}

// -------------------- Extractores --------------------
const RE = {
  greet: /\b(hola|buenas|hello|hi|hey)\b/i,
  reset: /(olvida|reinicia|reset|empecemos de nuevo)/i,
  surprise: /(sorpr[eé]ndeme|recom[ií]endame|what you suggest|surprise me)/i,

  // ciudad (ES/EN), ya no exige fin de frase
  newCity:
    /(estoy|and(o)?|ahora)\s+en\s+([a-záéíóúüñ .'-]{2,})|(?:ir[ée]?\s+a|voy\s+a|mañana\s+(voy|estar[eé])\s+en|on\s+(?:fri|sat|sun|mon|tue|wed|thu)[^\w]*\s*i'?m\s+going\s+to|i'?m\s+in)\s+([a-zA-Záéíóúüñ .'-]{2,})/i,

  // slot solo "en X"
  citySolo: /^(en|in)\s+([a-zA-Záéíóúüñ .'-]{2,})$/i,

  zone: /(zona|colonia|barrio|neighbou?rhood|area)\s+([a-zA-Záéíóúüñ .'-]{2,})/i,
  budget: /(\$|USD|MXN|EUR|euros|pesos|d[oó]lares|dlls)\s*([0-9]{2,6})/i,

  cuisineMap: [
    { re: /(ramen|noodle)/i, v: "ramen" },
    { re: /(sushi|omakase|izakaya)/i, v: "sushi" },
    { re: /(pizza|trattoria|pasta|italian|italiana|osteria)/i, v: "italiana" },
    { re: /(tacos?|pastor|birria|barbacoa|taquer)/i, v: "tacos" },
    { re: /(veg(etari[ao]|an)|vegan)/i, v: "vegetariana" },
    { re: /(mariscos?|sea ?food)/i, v: "mariscos" },
    { re: /(burger|hamburg)/i, v: "hamburguesa" },
    { re: /(japonesa|comida japonesa)/i, v: "japonesa" },
    { re: /(china|comida china)/i, v: "china" },
    { re: /(mexicana|comida mexicana)/i, v: "mexicana" },
    { re: /(thai|tailandesa)/i, v: "thai" },
    { re: /(india|indian|hind[uú])/i, v: "india" },
    { re: /(street\s*food|comida\s*callejera)/i, v: "street food" },
  ],

  photos: /(foto|fotos|picture|pictures|pics|photos|imagen|im[aá]genes|men[uú])/i,

  dishAt: /(qué\s+(?:platillos?|p(e|é)dir|recomiendas?)\s+en\s+([a-zA-Záéíóúüñ .'-]{2,}))|(?:what\s+(?:should|to)\s+order\s+at\s+([a-zA-Z .'-]{2,}))/i,
};

function pickCuisine(msg) {
  for (const e of RE.cuisineMap) if (e.re.test(msg)) return e.v;
  const m = msg.match(/(?:antojo\s+de|se\s+me\s+antoja|quiero|i\s+want)\s+([a-zA-Záéíóúüñ .'-]+)/i);
  return m ? m[1].trim().toLowerCase() : "";
}
function extract(msg) {
  const out = { city: "", zone: "", cuisine: "", budget: "" };

  const mCitySolo = msg.match(RE.citySolo);
  if (mCitySolo) out.city = (mCitySolo[2] || "").trim();

  const mNew = msg.match(RE.newCity);
  if (mNew) out.city = (mNew[3] || mNew[6] || "").trim();

  const mZone = msg.match(RE.zone);
  if (mZone) out.zone = (mZone[2] || "").trim();

  const mBud = msg.match(RE.budget);
  if (mBud) out.budget = mBud[2];

  const cu = pickCuisine(msg);
  if (cu) out.cuisine = cu;

  return out;
}

// -------------------- OSM (Nominatim + Overpass) --------------------
const NOMINATIM_EMAIL = process.env.NOMINATIM_EMAIL || "remy@example.com";
const UA = `RemyChef/${BUILD} (${NOMINATIM_EMAIL})`;

function normCity(c = "") {
  const s = c.toLowerCase().trim();
  if (!s) return "";
  if (/(méxico|mexico)\s+city/.test(s)) return "Ciudad de México";
  if (/^(mx|méxico|mexico)$/.test(s)) return "Ciudad de México";
  if (/^(cdmx|ciudad de mexico|mexico city)$/.test(s)) return "Ciudad de México";
  if (/^gdl$/.test(s)) return "Guadalajara";
  if (/^mty$/.test(s)) return "Monterrey";
  return c.trim();
}
async function geocode(q) {
  if (!q) return null;
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
  if (!first || first.type === "country") {
    const alt = normCity(city);
    if (alt !== city) return await geocode(alt);
  }
  return first;
}

// Overpass
const CHAIN_RE = [
  /vips/i, /sanborns/i, /toks/i, /starbucks/i, /domino/i, /little\s*caesars/i, /papa\s*john/i,
  /pizza\s*hutm?/i, /kfc/i, /burger\s*king|bk/i, /subway/i, /ihop/i, /chili'?s/i, /applebee'?s/i,
  /olive\s*garden/i, /dennys?/i, /sushi\s*roll/i, /wingstop/i, /potzol?calli/i, /farolito/i
];
const FINE_RE = /trattoria|osteria|bistro|brasserie|steakhouse|asador|omakase|kaiseki|chef|tasting|degustaci(ó|o)n|alta\s*cocina|fine|gastronom|izakaya|enoteca/i;
const STREET_HINT = /tacos?|birria|pastor|barbacoa|antojitos?|garnachas?|mariscos?|pozole|tlayuda|arepa|empanada/i;

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
async function overpass({ lat, lon, radius, nameRe, cuisineRe, includeFastFood, dietFlag }) {
  const around = `around:${Math.max(700, Math.min(6000, radius))},${lat},${lon}`;
  const data = `
[out:json][timeout:30];
(
  node["amenity"~"^(restaurant${includeFastFood ? "|fast_food" : ""}|cafe)$"]${cuisineRe ? `["cuisine"~"${cuisineRe}",i]` : ""}(${around});
  way ["amenity"~"^(restaurant${includeFastFood ? "|fast_food" : ""}|cafe)$"]${cuisineRe ? `["cuisine"~"${cuisineRe}",i]` : ""}(${around});
  relation["amenity"~"^(restaurant${includeFastFood ? "|fast_food" : ""}|cafe)$"]${cuisineRe ? `["cuisine"~"${cuisineRe}",i]` : ""}(${around});
  ${nameRe ? `node["amenity"~"^(restaurant${includeFastFood ? "|fast_food" : ""}|cafe)$"]["name"~"${nameRe}",i](${around});` : ""}
  ${nameRe ? `way ["amenity"~"^(restaurant${includeFastFood ? "|fast_food" : ""}|cafe)$"]["name"~"${nameRe}",i](${around});` : ""}
  ${nameRe ? `relation["amenity"~"^(restaurant${includeFastFood ? "|fast_food" : ""}|cafe)$"]["name"~"${nameRe}",i](${around});` : ""}
  ${dietFlag ? `
    node["diet:vegetarian"~"yes",i](${around});
    way ["diet:vegetarian"~"yes",i](${around});
    relation["diet:vegetarian"~"yes",i](${around});
    node["diet:vegan"~"yes",i](${around});
    way ["diet:vegan"~"yes",i](${around});
    relation["diet:vegan"~"yes",i](${around});` : ""}
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
    tags: t,
    hasContact: !!(t.website || t.phone || t["contact:website"] || t["contact:phone"]),
  };
}
function isChain(name, tags) {
  if (!name) return false;
  if (CHAIN_RE.some((re) => re.test(name))) return true;
  if (tags.brand || tags["brand:wikidata"] || tags["brand:wikipedia"]) return true;
  return false;
}
function wantsStreetFood(cuisine) {
  return STREET_HINT.test(String(cuisine || ""));
}
function scorePlace(p, wantStreet, wantCuisine) {
  if (!p.name) return -999;
  if (isChain(p.name, p.tags || {})) return -999;

  let s = 0;
  if (p.amenity === "restaurant") s += 3;
  if (p.cuisines.length) s += 2;
  if (p.hasContact) s += 2;
  if (FINE_RE.test(p.name)) s += 3;

  if (wantCuisine) {
    const { cuisineRe, nameRe } = cuisineSyn(wantCuisine);
    const re = (cuisineRe || nameRe) ? new RegExp(cuisineRe || nameRe, "i") : null;
    if (re) {
      if (re.test(p.name)) s += 3;
      if (p.cuisines.some(c => re.test(c))) s += 2;
    }
  }
  if (wantStreet) {
    if (p.amenity === "fast_food") s += /taco|taquer|birria|pastor|barbacoa/i.test(p.name) ? 2 : -3;
  } else {
    if (p.amenity === "fast_food") s -= 5;
  }
  return s;
}
function dedupe(arr) {
  const seen = new Set();
  return arr.filter(p => {
    const k = (p.name + "|" + p.address).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}
async function searchPlaces({ lat, lon, cuisine = "", zoneProvided = false }) {
  const { nameRe, cuisineRe, diet } = cuisineSyn(cuisine);
  const wantStreet = wantsStreetFood(cuisine);
  let radius = zoneProvided ? 1500 : wantStreet ? 2500 : 3500;

  let els = await overpass({ lat, lon, radius, nameRe, cuisineRe, includeFastFood: wantStreet, dietFlag: diet });
  if (!els.length) {
    radius = Math.min(6000, radius + 2500);
    els = await overpass({ lat, lon, radius, nameRe, cuisineRe, includeFastFood: wantStreet, dietFlag: diet });
  }

  return dedupe(els.map(toPlace))
    .map(p => ({ ...p, _score: scorePlace(p, wantStreet, cuisine) }))
    .filter(p => p._score > 2)
    .sort((a, b) => b._score - a._score)
    .slice(0, 9);
}

// -------------------- Mensajes / badges --------------------
function formatBadges(p) {
  const t = p.tags || {};
  let mic = "";
  if (typeof t.michelin === "number") {
    if (t.michelin >= 100) mic = "★★★";
    else if (t.michelin >= 85) mic = "★★";
    else if (t.michelin >= 70) mic = "★";
    else if (t.michelin >= 55) mic = "Bib";
    else if (t.michelin >= 45) mic = "Sel";
  }
  const b50 = typeof t.best50 === "number" ? "50Best" : "";
  const la  = typeof t.laliste === "number" ? `${Math.round(t.laliste)} LaListe` : "";
  const g   = t.greenstar ? "🌿" : "";
  const parts = [mic, b50, la, g].filter(Boolean);
  return parts.length ? `[${parts.join(" · ")}] ` : "";
}
function greet(lang) {
  return lang === "es"
    ? "¡Hola! Soy Remy 👋 chef de cabecera y cazador de buenos lugares. ¿En qué ciudad estás y qué se te antoja?"
    : "Hey! I'm Remy 👋 your chef-y guide to great spots. Which city are you in and what are you craving?";
}
function ask(slot, lang) {
  const es = lang === "es";
  const map = {
    city: es ? "¿En qué ciudad estás?" : "Which city are you in?",
    cuisine: es ? "¿Qué se te antoja?" : "What are you craving?",
    zone: es ? "¿Alguna zona/colonia preferida?" : "Any preferred area/neighborhood?",
    budget: es ? "¿Presupuesto aproximado por persona?" : "Approx budget per person?",
    whichPlace: es ? "¿De qué lugar quieres ver fotos?" : "Which place do you want photos of?",
  };
  return map[slot];
}
function listMsg(items, lang, ctx) {
  const es = lang === "es";
  const head = es ? `Te dejo opciones${ctx ? ` en ${ctx}` : ""}:` : `Here are some options${ctx ? ` in ${ctx}` : ""}:`;
  const body = items.slice(0, 3).map(p => {
    const badges = formatBadges(p);
    const cuis = p.cuisines?.length ? ` (${p.cuisines.slice(0, 2).join(", ")})` : "";
    const addr = p.address ? ` — ${p.address}` : "";
    return `• ${badges}${p.name}${cuis}${addr}`;
  }).join("\n");
  return `${head}\n${body}`;
}
function softNudge(lang, city, cuisine) {
  const es = lang === "es";
  return es
    ? `No encontré algo claro aún. Dime **zona** (p. ej. Roma/Condesa/Polanco) o ajusto el antojo para darte algo top en ${city}${cuisine ? ` de ${cuisine}` : ""}.`
    : `Didn't land a clear hit. Tell me a **neighborhood** or tweak the craving to nail something great in ${city}${cuisine ? ` for ${cuisine}` : ""}.`;
}
function photoLinks(placeOrQuery, lat, lon, lang) {
  const q = encodeURIComponent(placeOrQuery);
  const g = `https://www.google.com/search?q=${q}&tbm=isch`;
  const ig = `https://www.instagram.com/explore/search/keyword/?q=${q}`;
  const map = lat && lon ? `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=18/${lat}/${lon}` : "";
  const es = lang === "es";
  return `${es ? "Atajos para ver fotos/menú" : "Quick photo/menu links"}:\n• Google Images — ${g}\n• Instagram — ${ig}${map ? `\n• Map — ${map}` : ""}`;
}
function dishAdviceByCuisine(cuis, lang) {
  const es = lang === "es";
  const set = new Set(cuis.map(c => c.toLowerCase()));
  if ([...set].some(c => /ramen|noodle/.test(c))) {
    return es ? "Suele funcionar: un **ramen** de caldo intenso (tonkotsu/shoyu) y **gyoza**. Si prefieres ligero, pide uno de pollo o veggie."
              : "Go for a **ramen** with rich broth (tonkotsu/shoyu) and **gyoza**. Lighter? Try chicken or veggie bowls.";
  }
  if ([...set].some(c => /sushi|omakase/.test(c))) {
    return es ? "Pide **nigiri** del día y algún **roll** sencillo. Si tienen **omakase**, es la apuesta segura."
              : "Order the day's **nigiri** and a simple **roll**. If they run **omakase**, that’s your best bet.";
  }
  if ([...set].some(c => /italian|pizza|pasta|trattoria|osteria/.test(c))) {
    return es ? "Busca **pasta fresca** y **pizza al horno**. Si ves **cacio e pepe** o **margherita**, suelen ser buenas pruebas."
              : "Look for **fresh pasta** and **wood-fired pizza**. **Cacio e pepe** or a solid **margherita** are great tells.";
  }
  if ([...set].some(c => /seafood|mariscos/.test(c))) {
    return es ? "Apuesta por **mariscos del día** y **parrilla**. Pregunta por el pescado recomendado."
              : "Go for the **catch of the day** and the **grill**. Ask for the recommended fish.";
  }
  if ([...set].some(c => /mexican|taco|barbacoa|birria|pastor/.test(c))) {
    return es ? "Prueba **tacos de la casa** y una **salsa** hecha al momento. Si hay **pastor** o **birria**, de cabeza."
              : "Try the **house tacos** and a fresh **salsa**. If they do **al pastor** or **birria**, that’s a win.";
  }
  return es ? "Pregunta por la **especialidad de la casa** y un platillo a la **parrilla** o **estacional**."
            : "Ask for the **house specialty** and something **grilled** or **seasonal**.";
}

// -------------------- Helper para responder y fijar awaitSlot --------------------
function send(res, s, { reply, followup = "", next = "" }) {
  s.awaitSlot = next || "";
  return res.json({
    reply,
    followup,
    slots: s.slots,
    next_slot: s.awaitSlot
  });
}
const nextOf = (label, lang) =>
  label === ask("cuisine", lang) ? "cuisine" :
  label === ask("budget", lang)  ? "budget"  :
  label === ask("zone", lang)    ? "zone"    :
  label === ask("city", lang)    ? "city"    : "";

// -------------------- Intent Router --------------------
function intentRouter(msg) {
  if (RE.reset.test(msg)) return "reset";
  if (RE.newCity.test(msg) || RE.citySolo.test(msg)) return "new_city";
  if (RE.photos.test(msg)) return "photo_request";
  if (RE.dishAt.test(msg)) return "dish_at_place";
  if (RE.surprise.test(msg) || pickCuisine(msg)) return "recommend";
  if (RE.zone.test(msg) || RE.budget.test(msg)) return "update_slot";
  if (RE.greet.test(msg)) return "chitchat";
  return "unknown";
}

// -------------------- API --------------------
app.get("/", (_, res) => res.send(`remy-chef ${BUILD}`));

app.post("/recommendation", async (req, res) => {
  const {
    message = "",
    username = "",
    manychat_user_id = "",
    slots: incomingSlots = {},
    city = "", zone = "", cuisine = "", budget = ""
  } = req.body || {};
  if (!manychat_user_id) return res.status(400).json({ error: "manychat_user_id is required" });

  const s = sess(manychat_user_id);

  // Idioma: fija si aún no está
  if (!s.lang) s.lang = detectLang(message || username);

  // merge slots del body primero
  setSlots(s, { ...incomingSlots, city, zone, cuisine, budget });

  // INTELIGENCIA: si esperábamos un slot y el usuario respondió algo corto, tómalo como ese slot
  const plain = norm(String(message || ""));
  const looksPlain = /^[a-zA-Záéíóúüñ .'\-]{2,40}$/.test(plain) && !/\b(foto|photos?|men[úu]|menu)\b/i.test(plain);
  if (s.awaitSlot && looksPlain) {
    if (s.awaitSlot === "zone") setSlots(s, { zone: plain });
    else if (s.awaitSlot === "city") setSlots(s, { city: plain });
    else if (s.awaitSlot === "cuisine") setSlots(s, { cuisine: plain });
    else if (s.awaitSlot === "budget") {
      const m = plain.match(/\d{2,6}/);
      if (m) setSlots(s, { budget: m[0] });
    }
  }

  // extrae de este mensaje
  const ex = extract(message);
  setSlots(s, ex);

  // decide intent (con override si parece zona "suelta")
  let intent = intentRouter(message);
  if (intent === "unknown" && s.slots.city && looksPlain && plain.length <= 30) {
    // Puede ser una colonia/área
    setSlots(s, { zone: plain });
    intent = "update_slot";
  }

  // ---------- INTENTS ----------
  if (intent === "reset") {
    resetSession(s);
    return send(res, s, {
      reply: greet(s.lang),
      followup: ask("city", s.lang),
      next: "city"
    });
  }

  // NEW CITY (recomienda con info parcial)
  if (intent === "new_city" && s.slots.city) {
    const pin = await geocodeCityZone(normCity(s.slots.city), s.slots.zone);
    if (!pin?.lat || !pin?.lon) {
      const q = ask("zone", s.lang);
      return send(res, s, {
        reply: s.lang === "es" ? `Entiendo. Para ubicarte mejor en ${s.slots.city}, ¿alguna zona/colonia?`
                               : `Got it. To place you in ${s.slots.city}, any neighborhood?`,
        followup: q, next: "zone"
      });
    }
    // Base canónica primero
    const canonical = findTopByPrestige({
      lat: parseFloat(pin.lat), lon: parseFloat(pin.lon),
      radiusKm: s.slots.zone ? 3 : 7,
      cuisine: s.slots.cuisine || "", limit: 9
    });
    if (canonical && canonical.length >= 3) {
      s.lastResults = canonical.map(r => ({
        id: "db/" + r.id, name: r.name,
        cuisines: (r.cuisine || "").split(",").map(x => x.trim()).filter(Boolean),
        address: r.address || [s.slots.city, s.slots.zone].filter(Boolean).join(", "),
        amenity: "restaurant", lat: r.lat, lon: r.lng,
        tags: { michelin: r.michelin_score, best50: r.best50_score, laliste: r.laliste_score, greenstar: r.greenstar }
      }));
      const ctx = [s.slots.city, s.slots.zone].filter(Boolean).join(", ");
      const follow = s.slots.cuisine ? (s.slots.budget ? "" : ask("budget", s.lang)) : ask("cuisine", s.lang);
      return send(res, s, {
        reply: listMsg(s.lastResults, s.lang, ctx),
        followup: follow,
        next: nextOf(follow, s.lang)
      });
    }
    // Fallback Overpass
    const results = await searchPlaces({
      lat: parseFloat(pin.lat), lon: parseFloat(pin.lon),
      cuisine: s.slots.cuisine, zoneProvided: !!s.slots.zone
    });
    s.lastResults = results;
    if (!results.length) {
      const nextQ = s.slots.zone ? ask("cuisine", s.lang) : ask("zone", s.lang);
      return send(res, s, { reply: softNudge(s.lang, s.slots.city, s.slots.cuisine), followup: nextQ, next: nextOf(nextQ, s.lang) });
    }
    const ctx = [s.slots.city, s.slots.zone].filter(Boolean).join(", ");
    const follow = s.slots.cuisine ? (s.slots.budget ? "" : ask("budget", s.lang)) : ask("cuisine", s.lang);
    return send(res, s, { reply: listMsg(results, s.lang, ctx), followup: follow, next: nextOf(follow, s.lang) });
  }

  // PHOTO REQUEST
  if (intent === "photo_request") {
    const nameFromMsg =
      (message.match(/en\s+([a-zA-Záéíóúüñ .'-]{2,})$/i)?.[1]) ||
      (message.match(/at\s+([a-zA-Z .'-]{2,})$/i)?.[1]) || "";
    if (nameFromMsg) {
      const p = (s.lastResults || []).find(r => r.name && new RegExp(nameFromMsg, "i").test(r.name));
      const text = p ? photoLinks(`${p.name} ${s.slots.city || ""}`, p.lat, p.lon, s.lang)
                     : photoLinks(`${nameFromMsg} ${s.slots.city || ""}`, null, null, s.lang);
      return send(res, s, { reply: text });
    }
    if (s.lastResults?.length) {
      const p = s.lastResults[0];
      const text = photoLinks(`${p.name} ${s.slots.city || ""}`, p.lat, p.lon, s.lang);
      return send(res, s, { reply: text });
    }
    const q = ask("whichPlace", s.lang);
    return send(res, s, { reply: q, next: "whichPlace" });
  }

  // DISH AT PLACE
  if (intent === "dish_at_place") {
    const m = message.match(RE.dishAt);
    const placeName = (m?.[3] || m?.[4] || "").trim();
    if (!placeName) {
      return send(res, s, { reply: s.lang === "es" ? "¿En qué lugar? Te digo qué pedir ;)" : "At which place? I’ll tell you what to order ;)" });
    }
    const p = (s.lastResults || []).find(r => new RegExp(placeName, "i").test(r.name || ""));
    const advice = p ? dishAdviceByCuisine(p.cuisines, s.lang) : dishAdviceByCuisine([], s.lang);
    const reply = s.lang === "es"
      ? `En **${placeName}**, ${advice}\n\nSi quieres, te paso atajos para ver fotos.`
      : `At **${placeName}**, ${advice}\n\nIf you want, I can share quick photo links.`;
    return send(res, s, { reply });
  }

  // RECOMMEND
  if (intent === "recommend") {
    if (!s.slots.city) {
      const q = ask("city", s.lang);
      return send(res, s, { reply: s.lang === "es" ? "¿En qué ciudad estás? Te recomiendo algo bueno." : "Which city are you in? I’ll suggest something good.", followup: q, next: "city" });
    }
    const pin = await geocodeCityZone(normCity(s.slots.city), s.slots.zone);
    if (!pin?.lat || !pin?.lon) {
      const q = ask("zone", s.lang);
      return send(res, s, { reply: s.lang === "es" ? `Para ubicarte en ${s.slots.city}, ¿alguna zona/colonia?` : `To place you in ${s.slots.city}, any neighborhood?`, followup: q, next: "zone" });
    }
    const canonical = findTopByPrestige({ lat: parseFloat(pin.lat), lon: parseFloat(pin.lon), radiusKm: s.slots.zone ? 3 : 7, cuisine: s.slots.cuisine || "", limit: 9 });
    if (canonical && canonical.length >= 3) {
      s.lastResults = canonical.map(r => ({
        id: "db/" + r.id, name: r.name,
        cuisines: (r.cuisine || "").split(",").map(x => x.trim()).filter(Boolean),
        address: r.address || [s.slots.city, s.slots.zone].filter(Boolean).join(", "),
        amenity: "restaurant", lat: r.lat, lon: r.lng,
        tags: { michelin: r.michelin_score, best50: r.best50_score, laliste: r.laliste_score, greenstar: r.greenstar }
      }));
      const ctx = [s.slots.city, s.slots.zone].filter(Boolean).join(", ");
      const follow = s.slots.cuisine ? (s.slots.budget ? "" : ask("budget", s.lang)) : ask("cuisine", s.lang);
      return send(res, s, { reply: listMsg(s.lastResults, s.lang, ctx), followup: follow, next: nextOf(follow, s.lang) });
    }
    const results = await searchPlaces({ lat: parseFloat(pin.lat), lon: parseFloat(pin.lon), cuisine: s.slots.cuisine, zoneProvided: !!s.slots.zone });
    s.lastResults = results;
    if (!results.length) {
      const nextQ = s.slots.zone ? ask("cuisine", s.lang) : ask("zone", s.lang);
      return send(res, s, { reply: softNudge(s.lang, s.slots.city, s.slots.cuisine), followup: nextQ, next: nextOf(nextQ, s.lang) });
    }
    const ctx = [s.slots.city, s.slots.zone].filter(Boolean).join(", ");
    const follow = s.slots.cuisine ? (s.slots.budget ? "" : ask("budget", s.lang)) : ask("cuisine", s.lang);
    return send(res, s, { reply: listMsg(results, s.lang, ctx), followup: follow, next: nextOf(follow, s.lang) });
  }

  // UPDATE SLOT (zona/presupuesto)
  if (intent === "update_slot") {
    if (!s.slots.city) {
      const q = ask("city", s.lang);
      return send(res, s, { reply: s.lang === "es" ? "Perfecto. ¿En qué ciudad estás?" : "Great. Which city are you in?", followup: q, next: "city" });
    }
    const pin = await geocodeCityZone(normCity(s.slots.city), s.slots.zone);
    if (!pin?.lat || !pin?.lon) {
      const q = ask("zone", s.lang);
      return send(res, s, { reply: s.lang === "es" ? `Para ubicarte en ${s.slots.city}, ¿qué zona?` : `To place you in ${s.slots.city}, which area?`, followup: q, next: "zone" });
    }
    const canonical = findTopByPrestige({ lat: parseFloat(pin.lat), lon: parseFloat(pin.lon), radiusKm: s.slots.zone ? 3 : 7, cuisine: s.slots.cuisine || "", limit: 9 });
    if (canonical && canonical.length >= 3) {
      s.lastResults = canonical.map(r => ({
        id: "db/" + r.id, name: r.name,
        cuisines: (r.cuisine || "").split(",").map(x => x.trim()).filter(Boolean),
        address: r.address || [s.slots.city, s.slots.zone].filter(Boolean).join(", "),
        amenity: "restaurant", lat: r.lat, lon: r.lng,
        tags: { michelin: r.michelin_score, best50: r.best50_score, laliste: r.laliste_score, greenstar: r.greenstar }
      }));
      const ctx = [s.slots.city, s.slots.zone].filter(Boolean).join(", ");
      const follow = s.slots.budget ? "" : ask("budget", s.lang);
      return send(res, s, { reply: listMsg(s.lastResults, s.lang, ctx), followup: follow, next: nextOf(follow, s.lang) });
    }
    const results = await searchPlaces({ lat: parseFloat(pin.lat), lon: parseFloat(pin.lon), cuisine: s.slots.cuisine, zoneProvided: !!s.slots.zone });
    s.lastResults = results;
    if (!results.length) {
      const nextQ = s.slots.zone ? ask("cuisine", s.lang) : ask("zone", s.lang);
      return send(res, s, { reply: softNudge(s.lang, s.slots.city, s.slots.cuisine), followup: nextQ, next: nextOf(nextQ, s.lang) });
    }
    const ctx = [s.slots.city, s.slots.zone].filter(Boolean).join(", ");
    const follow = s.slots.budget ? "" : ask("budget", s.lang);
    return send(res, s, { reply: listMsg(results, s.lang, ctx), followup: follow, next: nextOf(follow, s.lang) });
  }

  // CHITCHAT / fallback con ciudad
  if (!s.slots.city) {
    const q = ask("city", s.lang);
    return send(res, s, { reply: greet(s.lang), followup: q, next: "city" });
  }
  const pin = await geocodeCityZone(normCity(s.slots.city), s.slots.zone);
  if (pin?.lat && pin?.lon) {
    const canonical = findTopByPrestige({ lat: parseFloat(pin.lat), lon: parseFloat(pin.lon), radiusKm: s.slots.zone ? 3 : 7, cuisine: s.slots.cuisine || "", limit: 9 });
    if (canonical && canonical.length >= 3) {
      s.lastResults = canonical.map(r => ({
        id: "db/" + r.id, name: r.name,
        cuisines: (r.cuisine || "").split(",").map(x => x.trim()).filter(Boolean),
        address: r.address || [s.slots.city, s.slots.zone].filter(Boolean).join(", "),
        amenity: "restaurant", lat: r.lat, lon: r.lng,
        tags: { michelin: r.michelin_score, best50: r.best50_score, laliste: r.laliste_score, greenstar: r.greenstar }
      }));
      const ctx = [s.slots.city, s.slots.zone].filter(Boolean).join(", ");
      const follow = s.slots.cuisine ? ask("budget", s.lang) : ask("cuisine", s.lang);
      return send(res, s, { reply: listMsg(s.lastResults, s.lang, ctx), followup: follow, next: nextOf(follow, s.lang) });
    }
    const results = await searchPlaces({ lat: parseFloat(pin.lat), lon: parseFloat(pin.lon), cuisine: s.slots.cuisine, zoneProvided: !!s.slots.zone });
    s.lastResults = results;
    if (results.length) {
      const ctx = [s.slots.city, s.slots.zone].filter(Boolean).join(", ");
      const follow = s.slots.cuisine ? ask("budget", s.lang) : ask("cuisine", s.lang);
      return send(res, s, { reply: listMsg(results, s.lang, ctx), followup: follow, next: nextOf(follow, s.lang) });
    }
  }
  const nextQ = s.slots.zone ? ask("cuisine", s.lang) : ask("zone", s.lang);
  return send(res, s, { reply: softNudge(s.lang, s.slots.city, s.slots.cuisine), followup: nextQ, next: nextOf(nextQ, s.lang) });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Remy Chef ${BUILD} listening on :${PORT}`));
