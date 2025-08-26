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

// ---------------------- Guardas costo/cache ----------------------
const memCache = new Map(); // key -> { ts, data }
const DAY_MS = 24 * 60 * 60 * 1000;

// límites configurables por env
const MAX_GLOBAL = Number(process.env.MAX_PLACES_CALLS_PER_DAY || 200);
const MAX_USER   = Number(process.env.MAX_PLACES_CALLS_PER_USER || 5);
const CACHE_TTL  = Number(process.env.SEARCH_CACHE_TTL_MS || 6*60*60*1000); // 6h

let daily = { date: new Date().toDateString(), globalCalls: 0, perUser: {} };

function resetDailyIfNeeded() {
  const today = new Date().toDateString();
  if (daily.date !== today) daily = { date: today, globalCalls: 0, perUser: {} };
}
function canSpend(userId) {
  resetDailyIfNeeded();
  const per = daily.perUser[userId] || 0;
  return daily.globalCalls < MAX_GLOBAL && per < MAX_USER;
}
function spend(userId) {
  daily.globalCalls++;
  daily.perUser[userId] = (daily.perUser[userId] || 0) + 1;
}
function keyFrom({ city, area, cuisine, budget }) {
  const bucket = budget ? Math.round(Number(budget) / 100) * 100 : "x";
  return [city?.toLowerCase(), area?.toLowerCase() || "", cuisine?.toLowerCase(), bucket].join("|");
}
function getCache(k) {
  const hit = memCache.get(k);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL) { memCache.delete(k); return null; }
  return hit.data; // { reply, followup }
}
function setCache(k, data) {
  memCache.set(k, { ts: Date.now(), data });
}

// ---------------------- Rutas ----------------------
app.get("/", (_req, res) => res.send("remy-ai-backend up"));

app.post("/recommendation", async (req, res) => {
  const { message = "", username = "", manychat_user_id = "" } = req.body || {};

  try {
    // 1) NLU barato: detectar intención + slots
    const nlu = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Extrae JSON con schema {intent:'SEARCH'|'CHAT', city, area, cuisine, budget_mxn}. " +
            "Si faltan datos para buscar, usa intent:'CHAT'."
        },
        { role: "user", content: message }
      ]
    });

    let slots = {};
    try { slots = JSON.parse(nlu.choices?.[0]?.message?.content || "{}"); } catch {}
    const intent  = slots.intent || "CHAT";
    const city    = (slots.city || "").trim();
    const area    = (slots.area || "").trim();
    const cuisine = (slots.cuisine || "").trim();
    const budget  = slots.budget_mxn ? Number(slots.budget_mxn) : null;

    const hasQuery = city && cuisine;

    // 2) Si aún falta info: conversa y pide SOLO lo que falta
    if (intent !== "SEARCH" || !hasQuery) {
      const clarify = await openai.chat.completions.create({
        model: "gpt-4",
        temperature: 0.7,
        messages: [
          {
            role: "system",
            content:
              "Eres Remy. Responde breve, amistoso y pide SOLO el dato que falta " +
              "(ciudad, antojo/cocina o presupuesto). No inventes lugares."
          },
          { role: "user", content: message }
        ]
      });
      return res.json({
        reply: clarify.choices?.[0]?.message?.content?.trim() || "¿Me dices ciudad y antojo?",
        followup: "Cuando me des ciudad + antojo, te busco opciones."
      });
    }

    // 3) Confirmación antes de gastar
    const wantsSearch = /(^|\b)(sí|si|buscar|dale|ok|hazlo)\b/i.test(message);
    if (!wantsSearch) {
      return res.json({
        reply: `Puedo buscar ${cuisine} en ${area ? area + ", " : ""}${city}. ¿Quieres que busque ahora?`,
        followup: "Responde “sí” para buscar, o dime colonia/presupuesto."
      });
    }

    // 4) Cache
    const cacheKey = keyFrom({ city, area, cuisine, budget });
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    // 5) Cupos diarios
    if (!canSpend(manychat_user_id)) {
      const reply =
        `Tengo búsquedas recientes de ${cuisine} en ${city}. ` +
        `Puedes explorar aquí (sin costo): ` +
        `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(cuisine + " " + (area ? area + " " : "") + city)}\n\n` +
        `Si quieres, dime colonia o un presupuesto y afinamos.`;
      const payload = { reply, followup: "¿Ajustamos zona o presupuesto?" };
      setCache(cacheKey, payload);
      return res.json(payload);
    }

    // 6) (Opcional) Integración con Places — DESACTIVADA por defecto
    // Aquí iría UNA llamada a Places (máx. 10-20 resultados) si decides activarla.
    // spend(manychat_user_id); setCache(cacheKey, {reply, followup}); return res.json({reply, followup});

    // Zero-API elegante (sin coste variable):
    const reply =
      `Te dejo una búsqueda directa de ${cuisine} en ${area ? area + ", " : ""}${city}: ` +
      `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(cuisine + " " + (area ? area + " " : "") + city)}\n\n` +
      `¿Quieres que te sugiera una ruta o ver otra cocina/zona?`;
    const payload = { reply, followup: "¿Cambiamos zona o presupuesto?" };
    setCache(cacheKey, payload);
    return res.json(payload);

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Error generating recommendation" });
  }
});

// ---------------------- Server ----------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
