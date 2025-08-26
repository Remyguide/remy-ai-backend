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

/**
 * Memoria de sesión simple en memoria del servidor.
 * Clave: manychat_user_id
 * Guarda: historial corto + "slots" (ciudad, zona, cocina, presupuesto) + timestamp
 * Nota: es suficiente para prototipos; en producción usa Redis/DB.
 */
const SESSIONS = new Map();
const TTL_MS = 1000 * 60 * 60 * 4; // 4 horas de inactividad
const MAX_TURNS = 8;               // últimos N turnos (usuario+asistente)

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
  // recorta para mantener sólo los últimos MAX_TURNS*2 mensajes aprox.
  const maxMsgs = MAX_TURNS * 2;
  if (session.history.length > maxMsgs) {
    session.history = session.history.slice(session.history.length - maxMsgs);
  }
}

/**
 * Une mensajes para el modelo: system + historial + mensaje actual.
 * Además le inyectamos el "estado" (slots) para que NO pregunte lo ya conocido.
 */
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
Eres **Remy**, un experto en restaurantes que conversa de forma breve, amable y práctica.
Reglas IMPORTANTES:
- Responde SIEMPRE en el mismo idioma del usuario.
- Usa la información de estado ya conocida; NO repitas preguntas que ya estén en “Estado actual”.
- Haz preguntas de seguimiento **una por turno** para completar lo que falte (cocina, zona, presupuesto…).
- Si el usuario ya dio una parte (p.ej. ciudad), confirma y avanza a lo siguiente.
- Sé local y concreto; 2–4 frases máx. + 1 pregunta de seguimiento.
- Devuelve **sólo JSON válido** con el siguiente esquema:

{
  "reply": "<texto para enviar al usuario (incluye tu pregunta de seguimiento al final)>",
  "followup": "<pregunta breve para continuar>",
  "slots": { "city": "<string|opcional>", "area": "<string|opcional>", "cuisine": "<string|opcional>", "budget_mxn": "<number|string|opcional>" }
}

No añadas nada fuera del JSON.

Estado actual del usuario:
${stateNote}
Usuario (ManyChat): ${username || "(desconocido)"}`
  };

  // Historial curto + nuevo turno
  const msgs = [system, ...session.history, { role: "user", content: incomingText }];
  return msgs;
}

/** Fusiona slots nuevos con los previos (sólo si vienen con valor). */
function mergeSlots(prev, incoming = {}) {
  const next = { ...prev };
  for (const k of ["city", "area", "cuisine", "budget_mxn"]) {
    const val = incoming[k];
    if (val !== undefined && val !== null && String(val).trim() !== "") {
      next[k] = String(val).trim();
    }
  }
  return next;
}

// Health check
app.get("/", (_req, res) => res.send("remy-ai-backend up"));

app.post("/recommendation", async (req, res) => {
  const { message = "", username = "", manychat_user_id = "" } = req.body || {};
  if (!message) return res.status(400).json({ error: "Missing 'message'." });
  const userId = manychat_user_id || `anon-${(req.ip || "x").replace(/[:.]/g, "")}`;

  const session = getSession(userId);
  pushHistory(session, "user", message);

  try {
    const messages = buildMessages(session, username, message);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",            // rápido y barato; puedes subir a gpt-4o o gpt-4.1 si quieres
      temperature: 0.7,
      messages,
    });

    // El modelo debería devolver puro JSON. De todos modos, parseamos con fallback.
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

    // Valores por defecto seguros
    let reply = "";
    let followup = "";
    let slots = {};
    if (data && typeof data === "object") {
      reply = (data.reply || "").toString();
      followup = (data.followup || "").toString();
      slots = data.slots || {};
    }
    if (!reply) {
      reply = "Puedo sugerirte lugares según tu antojo, zona y presupuesto. ¿Qué se te antoja y en qué ciudad estás?";
    }
    if (!followup) {
      followup = "¿Quieres otra opción, cambiar de zona o ajustar presupuesto?";
    }

    // Actualizamos memoria: slots + historial (guardamos el texto plano del asistente, no el JSON)
    session.slots = mergeSlots(session.slots, slots);
    pushHistory(session, "assistant", reply);

    // Opcional: si quieres que el usuario vea la pregunta de seguimiento, la añadimos al final del reply.
    const replyWithFollowup = followup && !reply.includes(followup)
      ? `${reply.trim()} ${followup.trim()}`
      : reply;

    return res.json({
      reply: replyWithFollowup,
      followup,        // disponible si luego lo mapeas en ManyChat
      // slots,        // opcionalmente puedes devolverlos si quieres depurar
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Error generating recommendation" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});


