// Remy "Chef" Backend — v5.0 (simple, fluido y seguro con OSM)
// - Intents con prioridad (sin loops): reset > new_city > photos > dish_at_place > recommend > update_slot > chitchat
// - Idioma por mensaje (ES/EN)
// - Recomienda aun con info parcial (si hay city, propone 2–3)
// - Filtro anti-cadenas y scoring por calidad
// - Overpass/Nominatim (evita costos de Google Places)
// - 1 pregunta por turno + CTA amable

import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const BUILD = "5.0.0";

// -------------------- Sesiones muy simples --------------------
const SESS = new Map();
function sess(id) {
  if (!SESS.has(id)) {
    SESS.set(id, {
      lang: "es",
      slots: { city: "", zone: "", cuisine: "", budget: "" },
      lastIntent: "",
      lastResults: [], // últimos lugares mostrados (para fotos / qué pedir)
      updatedAt: Date.now(),
    });
  }
  return SESS.get(id);
}
function setSlots(s, upd = {}) {
  const norm = (v) => (typeof v === "string" ? v.trim() : "");
  const next = { ...s.slots, ...upd };
  if (next.budget) {
    const m = String(next.budget).match(/\d{2,6}/);
    next.budget = m ? m[0] : "";
  }
  s.slots = {
    city: norm(next.city),
    zone: norm(next.zone),
    cuisine: norm(next.cuisine),
    budget: norm(next.budget),
  };
}
function resetSession(s) {
  s.slots = { city: "", zone: "", cuisine: "", budget: "" };
  s.lastIntent = "";
  s.lastResults = [];
}

// -------------------- Idioma por mensaje --------------------
function detectLang(text = "") {
  const t = text.toLowerCase();
  if (/[áéíóúñü¿¡]/.test(t)) return "es";
  if (/(hola|buenas|ciudad|zona|antojo|presupuesto|cdmx|méxico|mexico)/i.test(t)) return "es";
  return "en";
}

// -------------------- Extractores --------------------
const RE = {
  greet: /\b(hola|buenas|hello|hi|hey)\b/i,
  reset: /(olvida|reinicia|reset|empecemos de nuevo)/i,
  surprise: /(sorpr[eé]ndeme|recom[ií]endame|what you suggest|surprise me)/i,

  // nueva ciudad (ES/EN, futuro incluido)
  newCity:
    /(estoy|and(o)?|ahora)\s+en\s+([a-záéíóúüñ .'-]{2,})$|(?:ir[ée]?\s+a|voy\s+a|mañana\s+(voy|estar[eé])\s+en|on\s+(?:fri|sat|sun|mon|tue|wed|thu)[^\w]*\s*i'?m\s+going\s+to|i'?m\s+in)\s+([a-zA-Záéíóúüñ .'-]{2,})/i,

  // slot a pelo
  citySolo: /^(en|in)\s+([a-zA-Záéíóúüñ .'-]{2,})$/i,
  zone: /(zona|colonia|barrio|neighbou?rhood|area)\s+([a-zA-Záéíóúüñ .'-]{2,})/i,
  budget: /(\$|USD|MXN|EUR|euros|pesos|d[oó]lares|dlls)\s*([0-9]{2,6})/i,

  // cocina
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

  // fotos / menú
  photos: /(foto|fotos|picture|pictures|pics|photos|imagen|im[aá]genes|men[uú])/i,

  // qué pedir en X
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

// -------------------- Mensajes --------------------
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
    const cuis = p.cuisines?.length ? ` (${p.cuisines.slice(0, 2).join(", ")})` : "";
    const addr = p.address ? ` — ${p.address}` : "";
    return `• ${p.name}${cuis}${addr}`;
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
    return es
      ? "Suele funcionar: un **ramen** de caldo intenso (tonkotsu/shoyu) y **gyoza**. Si prefieres ligero, pide uno de pollo o veggie."
      : "Go for a **ramen** with rich broth (tonkotsu/shoyu) and **gyoza**. Lighter? Try chicken or veggie bowls.";
  }
  if ([...set].some(c => /sushi|omakase/.test(c))) {
    return es
      ? "Pide **nigiri** del día y algún **roll** sencillo. Si tienen **omakase**, es la apuesta segura."
      : "Order the day's **nigiri** and a simple **roll**. If they run **omakase**, that’s your best bet.";
  }
  if ([...set].some(c => /italian|pizza|pasta|trattoria|osteria/.test(c))) {
    return es
      ? "Busca **pasta fresca** y **pizza al horno**. Si ves **cacio e pepe** o **margherita**, suelen ser buenas pruebas."
      : "Look for **fresh pasta** and **wood-fired pizza**. **Cacio e pepe** or a solid **margherita** are great tells.";
  }
  if ([...set].some(c => /seafood|mariscos/.test(c))) {
    return es ? "Apuesta por **mariscos del día** y **parrilla**. Pregunta por el pescado recomendado." :
      "Go for the **catch of the day** and the **grill**. Ask for the recommended fish.";
  }
  if ([...set].some(c => /mexican|taco|barbacoa|birria|pastor/.test(c))) {
    return es ? "Prueba **tacos de la casa** y una **salsa** hecha al momento. Si hay **pastor** o **birria**, de cabeza." :
      "Try the **house tacos** and a fresh **salsa**. If they do **al pastor** or **birria**, that’s a win.";
  }
  return es ? "Pregunta por la **especialidad de la casa** y un platillo a la **parrilla** o **estacional**." :
    "Ask for the **house specialty** and something **grilled** or **seasonal**.";
}

// -------------------- INTENT ROUTER --------------------
function intentRouter(msg) {
  // 1) RESET
  if (RE.reset.test(msg)) return "reset";
  // 2) NEW CITY
  if (RE.newCity.test(msg) || RE.citySolo.test(msg)) return "new_city";
  // 3) PHOTOS
  if (RE.photos.test(msg)) return "photo_request";
  // 4) DISH AT PLACE
  if (RE.dishAt.test(msg)) return "dish_at_place";
  // 5) RECOMMEND (sorpréndeme o dice antojo)
  if (RE.surprise.test(msg) || pickCuisine(msg)) return "recommend";
  // 6) UPDATE SLOT (zona/presupuesto)
  if (RE.zone.test(msg) || RE.budget.test(msg)) return "update_slot";
  // 7) CHITCHAT
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
  s.lang = detectLang(message || username);

  // merge slots del body
  setSlots(s, { ...incomingSlots, city, zone, cuisine, budget });

  const intent = intentRouter(message);
  const ex = extract(message);
  setSlots(s, ex);

  // INTENT: reset
  if (intent === "reset") {
    resetSession(s);
    return res.json({
      reply: greet(s.lang),
      followup: ask("city", s.lang),
      slots: s.slots,
      next_slot: "city"
    });
  }

  // INTENT: new city → recomienda ya con info parcial
  if (intent === "new_city" && s.slots.city) {
    const pin = await geocodeCityZone(normCity(s.slots.city), s.slots.zone);
    if (!pin?.lat || !pin?.lon) {
      return res.json({
        reply: s.lang === "es"
          ? `Entiendo. Para ubicarte mejor en ${s.slots.city}, ¿alguna zona/colonia?`
          : `Got it. To place you in ${s.slots.city}, any neighborhood?`,
        followup: ask("zone", s.lang),
        slots: s.slots,
        next_slot: "zone"
      });
    }
    const results = await searchPlaces({
      lat: parseFloat(pin.lat),
      lon: parseFloat(pin.lon),
      cuisine: s.slots.cuisine,
      zoneProvided: !!s.slots.zone
    });
    s.lastResults = results;

    if (!results.length) {
      return res.json({
        reply: softNudge(s.lang, s.slots.city, s.slots.cuisine),
        followup: s.slots.zone ? ask("cuisine", s.lang) : ask("zone", s.lang),
        slots: s.slots,
        next_slot: s.slots.zone ? "cuisine" : "zone"
      });
    }
    const ctx = [s.slots.city, s.slots.zone].filter(Boolean).join(", ");
    const follow = s.slots.cuisine ? (s.slots.budget ? "" : ask("budget", s.lang)) : ask("cuisine", s.lang);
    return res.json({
      reply: listMsg(results, s.lang, ctx),
      followup: follow,
      slots: s.slots,
      next_slot: follow ? (follow === ask("cuisine", s.lang) ? "cuisine" : "budget") : ""
    });
  }

  // INTENT: photo request
  if (intent === "photo_request") {
    // Si el usuario mencionó un lugar explícito dentro del mensaje, úsalo; de lo contrario, usa el primero de lastResults o pide cuál
    const nameFromMsg =
      (message.match(/en\s+([a-zA-Záéíóúüñ .'-]{2,})$/i)?.[1]) ||
      (message.match(/at\s+([a-zA-Z .'-]{2,})$/i)?.[1]) || "";
    if (nameFromMsg) {
      const p = (s.lastResults || []).find(r => r.name && new RegExp(nameFromMsg, "i").test(r.name));
      const text = p
        ? photoLinks(`${p.name} ${s.slots.city || ""}`, p.lat, p.lon, s.lang)
        : photoLinks(`${nameFromMsg} ${s.slots.city || ""}`, null, null, s.lang);
      return res.json({ reply: text, followup: "", slots: s.slots, next_slot: "" });
    }
    if (s.lastResults?.length) {
      const p = s.lastResults[0];
      const text = photoLinks(`${p.name} ${s.slots.city || ""}`, p.lat, p.lon, s.lang);
      return res.json({ reply: text, followup: "", slots: s.slots, next_slot: "" });
    }
    return res.json({
      reply: s.lang === "es" ? "¿De qué lugar quieres ver fotos?" : "Which place do you want photos of?",
      followup: ask("whichPlace", s.lang),
      slots: s.slots,
      next_slot: "whichPlace"
    });
  }

  // INTENT: qué pedir en X
  if (intent === "dish_at_place") {
    const m = message.match(RE.dishAt);
    const placeName = (m?.[3] || m?.[4] || "").trim();
    if (!placeName) {
      return res.json({
        reply: s.lang === "es" ? "¿En qué lugar? Te digo qué pedir ;)" : "At which place? I’ll tell you what to order ;)",
        followup: "",
        slots: s.slots, next_slot: ""
      });
    }
    // Busca en lastResults, si no, responde por cocina genérica
    const p = (s.lastResults || []).find(r => new RegExp(placeName, "i").test(r.name || ""));
    const advice = p ? dishAdviceByCuisine(p.cuisines, s.lang) : dishAdviceByCuisine([], s.lang);
    const reply = s.lang === "es"
      ? `En **${placeName}**, ${advice}\n\nSi quieres, te paso atajos para ver fotos.`
      : `At **${placeName}**, ${advice}\n\nIf you want, I can share quick photo links.`;
    return res.json({ reply, followup: "", slots: s.slots, next_slot: "" });
  }

  // INTENT: recommend (incluye “sorpréndeme” o ya hay cocina)
  if (intent === "recommend") {
    if (!s.slots.city) {
      return res.json({
        reply: s.lang === "es" ? "¿En qué ciudad estás? Te recomiendo algo bueno." : "Which city are you in? I’ll suggest something good.",
        followup: ask("city", s.lang),
        slots: s.slots, next_slot: "city"
      });
    }
    const pin = await geocodeCityZone(normCity(s.slots.city), s.slots.zone);
    if (!pin?.lat || !pin?.lon) {
      return res.json({
        reply: s.lang === "es" ? `Para ubicarte en ${s.slots.city}, ¿alguna zona/colonia?` : `To place you in ${s.slots.city}, any neighborhood?`,
        followup: ask("zone", s.lang),
        slots: s.slots, next_slot: "zone"
      });
    }
    const results = await searchPlaces({
      lat: parseFloat(pin.lat),
      lon: parseFloat(pin.lon),
      cuisine: s.slots.cuisine,
      zoneProvided: !!s.slots.zone
    });
    s.lastResults = results;

    if (!results.length) {
      return res.json({
        reply: softNudge(s.lang, s.slots.city, s.slots.cuisine),
        followup: s.slots.zone ? ask("cuisine", s.lang) : ask("zone", s.lang),
        slots: s.slots, next_slot: s.slots.zone ? "cuisine" : "zone"
      });
    }
    const ctx = [s.slots.city, s.slots.zone].filter(Boolean).join(", ");
    const follow = s.slots.cuisine ? (s.slots.budget ? "" : ask("budget", s.lang)) : ask("cuisine", s.lang);
    return res.json({
      reply: listMsg(results, s.lang, ctx),
      followup: follow,
      slots: s.slots,
      next_slot: follow ? (follow === ask("cuisine", s.lang) ? "cuisine" : "budget") : ""
    });
  }

  // INTENT: update slot (zona o presupuesto) → si ya hay city, recomienda; si no, pide ciudad
  if (intent === "update_slot") {
    if (!s.slots.city) {
      return res.json({
        reply: s.lang === "es" ? "Perfecto. ¿En qué ciudad estás?" : "Great. Which city are you in?",
        followup: ask("city", s.lang), slots: s.slots, next_slot: "city"
      });
    }
    const pin = await geocodeCityZone(normCity(s.slots.city), s.slots.zone);
    if (!pin?.lat || !pin?.lon) {
      return res.json({
        reply: s.lang === "es" ? `Para ubicarte en ${s.slots.city}, ¿qué zona?` : `To place you in ${s.slots.city}, which area?`,
        followup: ask("zone", s.lang), slots: s.slots, next_slot: "zone"
      });
    }
    const results = await searchPlaces({
      lat: parseFloat(pin.lat),
      lon: parseFloat(pin.lon),
      cuisine: s.slots.cuisine,
      zoneProvided: !!s.slots.zone
    });
    s.lastResults = results;
    if (!results.length) {
      return res.json({
        reply: softNudge(s.lang, s.slots.city, s.slots.cuisine),
        followup: s.slots.zone ? ask("cuisine", s.lang) : ask("zone", s.lang),
        slots: s.slots, next_slot: s.slots.zone ? "cuisine" : "zone"
      });
    }
    const ctx = [s.slots.city, s.slots.zone].filter(Boolean).join(", ");
    return res.json({
      reply: listMsg(results, s.lang, ctx),
      followup: s.slots.budget ? "" : ask("budget", s.lang),
      slots: s.slots, next_slot: s.slots.budget ? "" : "budget"
    });
  }

  // INTENT: chitchat o desconocido → saluda y mueve
  if (!s.slots.city) {
    return res.json({
      reply: greet(s.lang),
      followup: ask("city", s.lang),
      slots: s.slots, next_slot: "city"
    });
  }
  // con ciudad pero sin antojo → da algo rápido y pregunta 1 cosa
  const pin = await geocodeCityZone(normCity(s.slots.city), s.slots.zone);
  if (pin?.lat && pin?.lon) {
    const results = await searchPlaces({
      lat: parseFloat(pin.lat),
      lon: parseFloat(pin.lon),
      cuisine: s.slots.cuisine,
      zoneProvided: !!s.slots.zone
    });
    s.lastResults = results;
    if (results.length) {
      const ctx = [s.slots.city, s.slots.zone].filter(Boolean).join(", ");
      const follow = s.slots.cuisine ? ask("budget", s.lang) : ask("cuisine", s.lang);
      return res.json({
        reply: listMsg(results, s.lang, ctx),
        followup: follow, slots: s.slots,
        next_slot: follow === ask("cuisine", s.lang) ? "cuisine" : "budget"
      });
    }
  }
  return res.json({
    reply: softNudge(s.lang, s.slots.city, s.slots.cuisine),
    followup: s.slots.zone ? ask("cuisine", s.lang) : ask("zone", s.lang),
    slots: s.slots, next_slot: s.slots.zone ? "cuisine" : "zone"
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Remy Chef ${BUILD} listening on :${PORT}`));
