// index.js (reemplazo completo)
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { OpenAI } from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ========== Memoria por usuario (prototipo) ========== */
const SESSIONS = new Map();
const TTL_MS = 1000 * 60 * 60 * 4; // 4 horas
const MAX_TURNS = 8;

// Reset MUY permisivo (spa/en)
const RESET_REGEX =
  /\b(olvida(telo)?|borra(r)?|reinicia(r)?|reset(ear)?|empec(emos|emos de nuevo|emos otra vez)|empez(ar|amos de nuevo|amos otra vez)|comenc(emos|emos de nuevo)|borr[oó]n y cuenta nueva|start over|reset conversation)\b/i;

function freshSession() {
  return {
    history: [],
    slots: { city: "", area: "", cuisine: "", budget_mxn: "" },
    lastActive: Date.now(),
  };
}
function getSession(userId) {
  const now = Date.now();
  let s = SESSIONS.get(userId);
  if (!s || now - s.lastActive > TTL_MS) {
    s = freshSession();
    SESSIONS.set(userId, s);
  }
  s.lastActive = now;
  return s;
}
function pushHistory(session, role, content) {
  session.history.push({ role, content });
  const maxMsgs = MAX_TURNS * 2;
  if (session.history.length > maxMsgs) {
    session.history = session.history.slice(-maxMsgs);
  }
}
function mergeSlots(prev, incoming = {}) {
  const next = { ...prev };
  for (const k of ["city", "area", "cuisine", "budget_mxn"]) {
    const v = incoming[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") {
      next[k] = String(v).trim();
    }
  }
  return next;
}

/* ========== Mini-NLU para overrides rápidos ========== */
// Lista de topónimos comunes (puedes ampliar)
const CITY_ALIASES = [
  ["cdmx", "Ciudad de México", "Mexico City", "Ciudad de Mexico", "DF"],
  ["celaya"],
  ["querétaro", "queretaro"],
  ["córdoba, veracruz", "cordoba, veracruz", "cordoba", "córdoba"],
  ["veracruz"],
  ["ibiza"],
  ["guadalajara"],
  ["monterrey"],
];
const CUISINES = [
  "tacos","ramen","sushi","pizza","pasta","mariscos","carnitas","pastor",
  "hamburguesas","barbacoa","asado","birria","ceviche","alitas","pozole",
];

function parseOverrides(text) {
  const msg = (text || "").toLowerCase();

  // Presupuesto: $500, 500 mxn, 500 pesos
  const budgetMatch =
    msg.match(/\$?\s*([1-9]\d{2,5})\s*(mxn|pesos)?\b/) || null;
  const budget_mxn = budgetMatch ? budgetMatch[1] : "";

  // Ciudad (reconoce alias simples y CDMX)
  let city = "";
  for (const group of CITY_ALIASES) {
    for (const alias of group) {
      if (msg.includes(alias.toLowerCase())) {
        city = group[0]; // el primero como canónico (p.ej. "cdmx")
        break;
      }
    }
    if (city) break;
  }
  // Frases tipo "en <ciudad>"
  if (!city) {
    const enMatch = msg.match(/\ben\s+([a-záéíóúñü\s]+)\b/);
    if (enMatch) {
      const guess = enMatch[1].trim();
      // evita capturar "en" + palabras muy cortas
      if (guess.length >= 3 && !guess.includes(" yo ") && !guess.includes(" mi ")) {
        city = guess;
      }
    }
  }

  // Antojo/cocina
  let cuisine = "";
  for (const c of CUISINES) {
    if (msg.includes(c)) {
      cuisine = c;
      break;
    }
  }

  return {
    city,
    cuisine,
    budget_mxn,
    // área/colonia podemos intentar más adelante si lo necesitas
  };
}

/* ========== Mensajes al modelo ========== */
function buildMessages(session, username, incomingText, overrides) {
  const stateNote = [
    session.slots.city ? `• Ciudad/municipio: ${session.slots.city}` : "",
    session.slots.area ? `• Zona/colonia: ${session.slots.area}` : "",
    session.slots.cuisine ? `• Antojo/tipo de cocina: ${session.slots.cuisine}` : "",
    session.slots.budget_mxn ? `• Presupuesto (MXN): ${session.slots.budget_mxn}` : "",
  ].filter(Boolean).join("\n") || "• (sin datos aún)";

  const overrideNote = Object.entries(overrides)
    .filter(([,v]) => v)
    .map(([k,v]) => `• ${k}: ${v}`)
    .join("\n") || "• (sin overrides)";

  const system = {
    role: "system",
    content: `
Eres **Remy**, experto en restaurantes. Sé breve y útil.
- Responde SIEMPRE en el idioma del usuario.
- Usa el “Estado actual” y **no repitas** preguntas ya respondidas.
- Si el usuario **corrige** (p.ej., cambia la ciudad), **actualiza** ese valor.
- Haz **una** pregunta breve de seguimiento por turno.
- Devuelve **sólo JSON** EXACTO con este esquema:

{
  "reply": "<texto para el usuario (incluye tu pregunta de seguimiento al final)>",
  "followup": "<pregunta breve>",
  "slots": {
    "city": "<string o vacío>",
    "area": "<string o vacío>",
    "cuisine": "<string o vacío>",
    "budget_mxn": "<número o string o vacío>"
  }
}

IMPORTANTE:
1) **Devuelve SIEMPRE "slots"** (aunque no hayan cambiado).
2) Si el usuario aporta un dato nuevo, **actualízalo** en slots.
3) Prioriza los **overrides** proporcionados por el sistema cuando existan.

Estado actual:
${stateNote}

Overrides detectados en este turno:
${overrideNote}

Usuario (ManyChat): ${username || "(desconocido)"}`
      .trim(),
  };

  return [system, ...session.history, { role: "user", content: incomingText }];
}

/* ========== Health ========== */
app.get("/", (_req, res) => res.send("remy-ai-backend up"));

/* ========== Endpoint principal ========== */
app.post("/recommendation", async (req, res) => {
  const { message = "", username = "", manychat_user_id = "" } = req.body || {};
  if (!message) return res.status(400).json({ error: "Missing 'message'." });

  const userId = manychat_user_id || `anon-${(req.ip || "x").replace(/[:.]/g, "")}`;

  // RESET si el usuario lo pide (ahora sí incluye "Empecemos de nuevo")
  if (RESET_REGEX.test(message)) {
    SESSIONS.set(userId, freshSession());
    return res.json({
      reply:
        "¡Listo! Empecemos de cero. Dime en qué ciudad estás y qué se te antoja (por ejemplo, ramen en CDMX).",
      followup: "¿En qué ciudad estás y qué quieres comer?",
    });
  }

  const session = getSession(userId);

  // Overrides rápidos desde el texto del usuario
  const overrides = parseOverrides(message);
  session.slots = mergeSlots(session.slots, overrides);

  pushHistory(session, "user", message);

  try {
    const messages = buildMessages(session, username, message, overrides);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.7,
      messages,
    });

    let raw = completion.choices?.[0]?.message?.content?.trim() || "";
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) {
        try { data = JSON.parse(m[0]); } catch {}
      }
    }

    let reply = "";
    let followup = "";
    let slots = {};
    if (data && typeof data === "object") {
      reply = (data.reply || "").toString();
      followup = (data.followup || "").toString();
      slots = data.slots || {};
    }
    if (!reply) {
      reply = "Puedo sugerirte lugares según tu antojo, zona y presupuesto. ¿En qué ciudad estás y qué se te antoja?";
    }
    if (!followup) {
      followup = "¿Quieres otra opción, cambiar de zona o ajustar presupuesto?";
    }

    // Fusión final de slots (modelo + overrides del turno)
    session.slots = mergeSlots(session.slots, slots);
    pushHistory(session, "assistant", reply);

    const replyWithFollowup =
      followup && !reply.includes(followup) ? `${reply.trim()} ${followup.trim()}` : reply;

    return res.json({ reply: replyWithFollowup, followup, slots: session.slots });
  } catch (err) {
    console.error("LLM error:", err);
    return res.status(500).json({ error: "Error generating recommendation" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
