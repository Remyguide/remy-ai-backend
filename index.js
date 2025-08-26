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

/* ------- Memoria en servidor (prototipo) ------- */
const SESSIONS = new Map();
const TTL_MS = 1000 * 60 * 60 * 4; // 4 h
const MAX_TURNS = 8;
const RESET_REGEX = /\b(olvida|borra|reinicia|reset|emp(e|ie)cemos de cero|start over)\b/i;

function getSession(userId) {
  const now = Date.now();
  let s = SESSIONS.get(userId);
  if (!s || now - s.lastActive > TTL_MS) {
    s = { history: [], slots: { city: "", area: "", cuisine: "", budget_mxn: "" }, lastActive: now };
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

/* ------- Mensajes para el modelo ------- */
function buildMessages(session, username, incomingText) {
  const stateNote = [
    session.slots.city ? `• Ciudad/municipio: ${session.slots.city}` : "",
    session.slots.area ? `• Zona/colonia: ${session.slots.area}` : "",
    session.slots.cuisine ? `• Antojo/tipo de cocina: ${session.slots.cuisine}` : "",
    session.slots.budget_mxn ? `• Presupuesto aprox (MXN): ${session.slots.budget_mxn}` : "",
  ].filter(Boolean).join("\n") || "• (sin datos aún)";

  const system = {
    role: "system",
    content: `
Eres **Remy**, experto en restaurantes. Estilo: breve, amable, útil.
Reglas CLAVE:
- Responde SIEMPRE en el idioma del usuario.
- Usa el “Estado actual” y **no repitas** preguntas ya respondidas.
- Si el usuario **corrige** (p.ej., cambia la ciudad), **actualiza** el valor.
- Haz **una** pregunta de seguimiento por turno como máximo.
- Devuelve **sólo JSON válido** exactamente con este esquema (sin texto extra):

{
  "reply": "<texto para enviar al usuario (incluye tu pregunta de seguimiento al final)>",
  "followup": "<pregunta breve para continuar>",
  "slots": {
    "city": "<string o vacío si no aplica>",
    "area": "<string o vacío>",
    "cuisine": "<string o vacío>",
    "budget_mxn": "<número o string o vacío>"
  }
}

IMPORTANTÍSIMO: **Devuelve SIEMPRE el objeto "slots"** con tu mejor estado actual (aunque sean los mismos valores de antes). Si detectas que el usuario cambió un dato, devuelve el **nuevo** valor en slots.

Estado actual:
${stateNote}
Usuario (ManyChat): ${username || "(desconocido)"}
`.trim(),
  };

  return [system, ...session.history, { role: "user", content: incomingText }];
}

/* ------- Health ------- */
app.get("/", (_req, res) => res.send("remy-ai-backend up"));

/* ------- Endpoint principal ------- */
app.post("/recommendation", async (req, res) => {
  const { message = "", username = "", manychat_user_id = "" } = req.body || {};
  if (!message) return res.status(400).json({ error: "Missing 'message'." });

  const userId = manychat_user_id || `anon-${(req.ip || "x").replace(/[:.]/g, "")}`;

  // RESET de conversación si el usuario lo pide
  if (RESET_REGEX.test(message)) {
    SESSIONS.delete(userId);
    return res.json({
      reply:
        "¡Listo! Empecemos de cero. Dime en qué ciudad estás y qué se te antoja (por ejemplo, ramen en Celaya).",
      followup: "¿En qué ciudad estás y qué quieres comer?",
    });
  }

  const session = getSession(userId);
  pushHistory(session, "user", message);

  try {
    const messages = buildMessages(session, username, message);

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
    let follow



