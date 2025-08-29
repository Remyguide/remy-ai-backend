// Remy "Chef" Backend v4.2 — Saludo y lógica de flujo robusta
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { OpenAI } from "openai";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const BUILD = "4.2.0";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// =============== Sesiones ===============
const SESS = new Map();
const SESSION_IDLE_MS = 15 * 60 * 1000; // 15 min

function session(id) {
  if (!SESS.has(id)) {
    SESS.set(id, {
      lang: "es",
      slots: { city: "", zone: "", cuisine: "", budget: "" },
      greetedAt: 0,
      lastAsked: "",
      lastMsgAt: 0,
    });
  }
  return SESS.get(id);
}

function reset(id) {
  const s = session(id);
  s.slots = { city: "", zone: "", cuisine: "", budget: "" };
  s.lastAsked = "";
  s.greetedAt = 0;
  s.lastMsgAt = Date.now();
}

function setSlots(id, upd = {}) {
  const s = session(id);
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

// =============== Idioma ===============
function detectLang(text = "") {
  const t = text.toLowerCase();
  if (/[áéíóúñü¿¡]/.test(t)) return "es";
  if (/(hola|buenas|ciudad|zona|antojo|presupuesto|cdmx|méxico|mexico)/i.test(t)) return "es";
  return "en";
}

function useLang(current, message) {
  return detectLang(message) || current || "es";
}

// =============== Extractores rápidos ===============
const GREET_RE = /\b(hola|qué onda|buenas|hello|hi|hey)\b/i;
const RESET_RE = /(olvida|reinicia|empecemos de nuevo|reset)/i;
const WANT_SURPRISE_RE = /(sorpr[eé]ndeme|recom[ií]end[a|ame]|lo que t[uú] sugieras)/i;

function rxCity(msg) {
  const m =
    msg.match(/\b(?:estoy|ahora)\s+en\s+([a-záéíóúüñ .'-]+)$/i) ||
    msg.match(/^\s*en\s+([a-záéíóúüñ .'-]+)\s*$/i) ||
    msg.match(/\b(ciudad de m[ée]xico|méxico|cdmx|mexico|guadalajara|monterrey)\b/i);
  return m ? m[1].trim() : "";
}

function rxCuisine(msg) {
  const map = [
    { re: /(ramen|noodle)/i, v: "ramen" },
    { re: /(sushi|omakase|izakaya)/i, v: "sushi" },
    { re: /(pizza|trattoria|pasta|italian|italiana|osteria)/i, v: "italiana" },
    { re: /(tacos?|pastor|birria|barbacoa|taquer)/i, v: "tacos" },
    { re: /(veg(etari[ao]|an))/i, v: "vegetariana" },
    { re: /(mariscos?|sea ?food)/i, v: "mariscos" },
    { re: /(burg(er|uesa)|hamburg)/i, v: "hamburguesa" },
    { re: /(japonesa|comida japonesa)/i, v: "japonesa" },
    { re: /(china|comida china)/i, v: "china" },
    { re: /(mexicana|comida mexicana)/i, v: "mexicana" },
    { re: /(comida callejera|street food)/i, v: "street food" }
  ];
  for (const e of map) if (e.re.test(msg)) return e.v;
  const m = msg.match(/(?:tengo\s+antojo\s+de|se\s+me\s+antoja|quiero)\s+([a-záéíóúüñ .'-]+)/i);
  return m ? m[1].trim() : "";
}

function rxBudget(msg) {
  const m = msg.match(/\$?\s?(\d{2,6})\s*(mxn|pesos|usd)?/i);
  return m ? m[1] : "";
}

// =============== NLU (mezcla LLM + regex) ===============
async function extractNLU(message, prevSlots) {
  const sys = `Devuelve SOLO JSON:
{"updates":{"city":"","zone":"","cuisine":"","budget":""},"intent":"recommend|update|reset|chitchat|unknown"}
- "olvida/reinicia..." => intent=reset
- "hola/hello/hi..." => chitchat
- "estoy en/en X" => city
- "zona/colonia X" => zone
- "tengo antojo de/quiero/se me antoja X" => cuisine
- "$300 / 300 pesos" => budget (solo número)
- Si dice "sorpréndeme/recomiéndame" => intent=recommend`;

  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: `msg: """${message}"""\nprev: ${JSON.stringify(prevSlots)}` },
      ],
    });
    const txt = r.choices?.[0]?.message?.content?.trim() || "{}";
    const j = JSON.parse(txt);
    if (!j.updates) j.updates = {};
    j.updates.city ||= rxCity(message);
    j.updates.cuisine ||= rxCuisine(message);
    j.updates.budget ||= rxBudget(message);
    if (!j.intent) j.intent = GREET_RE.test(message) ? "chitchat" : "update";
    return j;
  } catch (err) {
    console.error("OpenAI NLU error:", err);
    return { updates: { city: rxCity(message), cuisine: rxCuisine(message), budget: rxBudget(message) }, intent: "update" };
  }
}

// =============== Geocodificación (Nominatim/OSM) ===============
const NOMINATIM_EMAIL = process.env.NOMINATIM_EMAIL || "remy@example.com";
const UA = `Remy-Chef/${BUILD} (${NOMINATIM_EMAIL})`;

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

// =============== Búsqueda Overpass (OSM) ===============
const CHAIN_RE = [
  /vips/i, /sanborns/i, /toks/i, /starbucks/i, /domino/i, /little\s*caesars/i, /papa\s*john/i,
  /pizza\s*hutm?/i, /kfc/i, /burger\s*king|bk/i, /subway/i, /ihop/i, /chili'?s/i, /applebee'?s/i,
  /olive\s*garden/i, /dennys?/i, /sushi\s*roll/i, /wingstop/i, /potzolcalli/i, /farolito/i
];
const FINE_RE = /trattoria|osteria|bistro|brasserie|steakhouse|asador|omakase|kaiseki|chef|tasting|degustaci(ó|o)n|alta\s*cocina|fine|gastronom|izakaya/i;
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
  const fast = includeFastFood ? "|fast_food" : "";
  const nameF = nameRe ? `["name"~"${nameRe}",i]` : "";
  const cuisineF = cuisineRe ? `["cuisine"~"${cuisineRe}",i]` : "";
  const diet = dietFlag ? `
    node["diet:vegetarian"~"yes",i](${around});
    way ["diet:vegetarian"~"yes",i](${around});
    relation["diet:vegetarian"~"yes",i](${around});
    node["diet:vegan"~"yes",i](${around});
    way ["diet:vegan"~"yes",i](${around});
    relation["diet:vegan"~"yes",i](${around});` : "";

  const data = `
[out:json][timeout:30];
(
  node["amenity"~"^(restaurant${includeFastFood ? "|fast_food" : ""}|cafe)$"]${cuisineF}(${around});
  way ["amenity"~"^(restaurant${includeFastFood ? "|fast_food" : ""}|cafe)$"]${cuisineF}(${around});
  relation["amenity"~"^(restaurant${includeFastFood ? "|fast_food" : ""}|cafe)$"]${cuisineF}(${around});
  node["amenity"~"^(restaurant${includeFastFood ? "|fast_food" : ""}|cafe)$"]${nameF}(${around});
  way ["amenity"~"^(restaurant${includeFastFood ? "|fast_food" : ""}|cafe)$"]${nameF}(${around});
  relation["amenity"~"^(restaurant${includeFastFood ? "|fast_food" : ""}|cafe)$"]${nameF}(${around});
  ${diet}
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

function dedupe(arr) {
  const seen = new Set();
  return arr.filter(p => {
    const k = (p.name + "|" + p.address).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
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

function scoreQuality(p, wantStreet, wantCuisine) {
  if (!p.name) return -999;
  if (isChain(p.name, p.tags || {})) return -999;

  let s = 0;
  if (p.amenity === "restaurant") s += 3;
  if (p.cuisines.length) s += 2;
  if (p.hasContact) s += 2;
  if (/wine|bar\s*a\s*vins|enoteca/i.test(p.name)) s += 1;

  if (wantCuisine) {
    const { cuisineRe, nameRe } = cuisineSyn(wantCuisine);
    const re = (cuisineRe || nameRe) ? new RegExp(cuisineRe || nameRe, "i") : null;
    if (re) {
      if (re.test(p.name)) s += 3;
      if (p.cuisines.some(c => re.test(c))) s += 2;
    }
  }
  if (FINE_RE.test(p.name)) s += 3;

  if (wantStreet) {
    if (p.amenity === "fast_food") s += /taco|taquer|birria|pastor|barbacoa/i.test(p.name) ? 2 : -2;
  } else {
    if (p.amenity === "fast_food") s -= 5;
  }
  return s;
}

async function searchPlaces({ lat, lon, cuisine = "", zoneProvided = false }) {
  const { nameRe, cuisineRe, diet } = cuisineSyn(cuisine);
  const wantStreet = wantsStreetFood(cuisine);
  let radius = zoneProvided ? 1500 : wantStreet ? 2500 : 3500;

  let els = await overpass({ lat, lon, radius, nameRe, cuisineRe, includeFastFood: wantStreet, dietFlag: diet });
  if (!els.length) { radius = Math.min(6000, radius + 2500);
    els = await overpass({ lat, lon, radius, nameRe, cuisineRe, includeFastFood: wantStreet, dietFlag: diet });
  }

  const places = dedupe(els.map(toPlace))
    .map(p => ({ ...p, _score: scoreQuality(p, wantStreet, cuisine) }))
    .filter(p => p._score > 2)
    .sort((a, b) => b._score - a._score);

  return places.slice(0, 9);
}

// =============== Respuestas de conversación ===============
function greet(lang) {
  return lang === "es"
    ? "¡Hola! Soy Remy 👋 Chef de cabecera y cazador de buenos lugares. ¿En qué ciudad estás y qué se te antoja?"
    : "Hey! I'm Remy 👋 a chef-y guide to great spots. Which city are you in and what are you craving?";
}

function ask(slot, lang) {
  const es = lang === "es";
  const m = {
    city: es ? "¿En qué ciudad estás?" : "Which city are you in?",
    cuisine: es ? "¿Qué se te antoja?" : "What are you craving?",
    zone: es ? "¿Alguna zona/colonia preferida?" : "Any preferred area/neighborhood?",
    budget: es ? "¿Presupuesto aproximado por persona?" : "Approx budget per person?",
  };
  return m[slot];
}

function listMessage(items, lang, ctx) {
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
  if (es) {
    return `Para darte algo top en ${city}${cuisine ? ` para ${cuisine}` : ""}, dime si tienes **zona** (p. ej. Roma/Condesa/Polanco) o si prefieres ajustar el antojo.`;
  }
  return `To land something great in ${city}${cuisine ? ` for ${cuisine}` : ""}, tell me a **neighborhood** or tweak the craving.`;
}

// =============== API ===============
app.get("/", (_, res) => res.send(`remy-chef ${BUILD}`));

app.post("/recommendation", async (req, res) => {
  const {
    message = "",
    username = "",
    manychat_user_id = "",
    city: bodyCity = "", zone: bodyZone = "", cuisine: bodyCuisine = "", budget: bodyBudget = "",
    slots: bodySlots = {}
  } = req.body || {};
  if (!manychat_user_id) return res.status(400).json({ error: "manychat_user_id is required" });

  const s = session(manychat_user_id);
  s.lang = useLang(s.lang, message || username);

  try {
    const idle = Date.now() - (s.lastMsgAt || 0) > SESSION_IDLE_MS;
    const isHello = GREET_RE.test(message);
    const isReset = RESET_RE.test(message);

    if (isReset) {
      reset(manychat_user_id);
      return res.json({
        reply: s.lang === "es"
          ? "Listo, reinicié la conversación. ¿En qué ciudad estás y qué se te antoja?"
          : "Done, I reset our chat. Which city are you in and what are you craving?",
        followup: ask("city", s.lang),
        slots: session(manychat_user_id).slots,
        next_slot: "city",
      });
    }

    // Procesar slots del body y mensaje del usuario
    const slotsBefore = setSlots(manychat_user_id, {
      city: bodyCity, zone: bodyZone, cuisine: bodyCuisine, budget: bodyBudget,
      ...(bodySlots || {})
    });
    const nlu = await extractNLU(message, slotsBefore);
    setSlots(manychat_user_id, nlu.updates);
    const slots = session(manychat_user_id).slots;

    // Lógica de flujo principal
    if (idle || isHello) {
      s.greetedAt = Date.now();
      return res.json({
        reply: greet(s.lang),
        followup: ask("city", s.lang),
        slots,
        next_slot: "city",
      });
    }

    if (!slots.city) {
      return res.json({
        reply: s.lang === "es" ? "Para ayudarte bien, dime tu ciudad." : "To help properly, tell me your city.",
        followup: ask("city", s.lang),
        slots,
        next_slot: "city"
      });
    }

    if (!slots.cuisine && !WANT_SURPRISE_RE.test(message)) {
      return res.json({
        reply: s.lang === "es"
          ? `Perfecto, ${slots.city}. ¿Qué se te antoja hoy?`
          : `Great, ${slots.city}. What are you craving today?`,
        followup: ask("cuisine", s.lang),
        slots,
        next_slot: "cuisine"
      });
    }

    const pin = await geocodeCityZone(normalizeCity(slots.city), slots.zone);
    if (!pin?.lat || !pin?.lon) {
      return res.json({
        reply: s.lang === "es"
          ? `No ubico bien ${slots.zone ? `${slots.zone}, ` : ""}${slots.city}. ¿Qué colonia te queda cómodo?`
          : `I couldn't place ${slots.zone ? `${slots.zone}, ` : ""}${slots.city}. Which neighborhood works for you?`,
        followup: ask("zone", s.lang),
        slots,
        next_slot: "zone"
      });
    }

    const results = await searchPlaces({
      lat: parseFloat(pin.lat),
      lon: parseFloat(pin.lon),
      cuisine: slots.cuisine,
      zoneProvided: !!slots.zone
    });

    if (!results.length) {
      return res.json({
        reply: softNudge(s.lang, slots.city, slots.cuisine),
        followup: slots.zone ? ask("cuisine", s.lang) : ask("zone", s.lang),
        slots,
        next_slot: slots.zone ? "cuisine" : "zone"
      });
    }

    const ctx = [slots.city, slots.zone].filter(Boolean).join(", ");
    let follow = "";
    if (!slots.zone) follow = ask("zone", s.lang);
    else if (!slots.budget) follow = ask("budget", s.lang);

    return res.json({
      reply: listMessage(results, s.lang, ctx),
      followup: follow,
      slots,
      next_slot: follow ? (follow === ask("zone", s.lang) ? "zone" : "budget") : ""
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      reply: s.lang === "es" ? "Tuve un problema técnico. Probemos de nuevo." : "Technical hiccup. Let's try again.",
      followup: "",
      error: "internal_error"
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Remy Chef ${BUILD} listening on :${PORT}`));
