import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { OpenAI } from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Utilidades
const clean = (v) => (typeof v === "string" ? v.trim() : "");
const isEmpty = (v) => !v || !clean(v);

function extractBudget(text = "") {
  const t = (text || "").toLowerCase();
  const m =
    t.match(/\$?\s*([0-9]{2,5})(?:\s*(?:mxn|pesos?)?)\b/) ||
    t.match(/\b([0-9]{2,5})\s*(?:mxn|pesos?)\b/);
  if (!m) return "";
  return m[1];
}

function looksLikeReset(text = "") {
  const t = (text || "").toLowerCase();
  return /(olvida|reset|reinicia|empecemos|desde cero|borr[a|e]|empezar de nuevo)/i.test(
    t
  );
}

function infoScore(slots) {
  let s = 0;
  if (!isEmpty(slots.city)) s += 2;
  if (!isEmpty(slots.zone)) s += 1;
  if (!isEmpty(slots.cuisine)) s += 2;
  if (!isEmpty(slots.budget)) s += 1;
  return s;
}

// Health
app.get("/", (_req, res) => res.send("remy-ai-backend up"));

app.post("/recommendation", async (req, res) => {
  try {
    const {
      message = "",
      username = "",
      manychat_user_id = "",
      slots: clientSlots = {},
    } = req.body || {};

    // Normalizamos slots que vienen de Manychat
    let slots = {
      city: clean(clientSlots.city || ""),
      zone: clean(clientSlots.zone || ""),
      cuisine: clean(clientSlots.cuisine || ""),
      budget: clean(clientSlots.budget || ""),
    };

    // Reset conversacional
    if (looksLikeReset(message)) {
      slots = { city: "", zone: "", cuisine: "", budget: "" };
      return res.json({
        reply:
          "Listo, reinicié la conversación. ¿En qué ciudad estás y qué se te antoja?",
        followup: "Cuéntame ciudad y antojo para empezar ;)",
        slots,
        next_slot: "city",
      });
    }

    // Relleno de presupuesto si el usuario lo escribió libre
    if (isEmpty(slots.budget)) {
      const b = extractBudget(message);
      if (b) slots.budget = b;
    }

    // Decidimos si ya podemos recomendar “best-effort”
    const score = infoScore(slots);
    const minimalHasCityOrZone = !isEmpty(slots.city) || !isEmpty(slots.zone);
    const hasCuisineOrMentions =
      !isEmpty(slots.cuisine) ||
      /(taco|ramen|sushi|pizza|pasta|carnita|mexican|japon|ital|burger|marisc)/i.test(
        message
      );

    const canRecommend = minimalHasCityOrZone && hasCuisineOrMentions;

    // Priorización de siguiente campo a pedir
    const missingOrder = [
      isEmpty(slots.city) && isEmpty(slots.zone) ? "city" : "",
      isEmpty(slots.cuisine) ? "cuisine" : "",
      isEmpty(slots.budget) ? "budget" : "",
      isEmpty(slots.zone) ? "zone" : "",
    ].filter(Boolean);
    const next_slot = canRecommend ? missingOrder[0] || "" : missingOrder[0] || "city";

    // Instrucciones al modelo
    const system = `
Eres Remy, un guía de restaurantes conversacional.
Reglas:
- Responde SIEMPRE en el idioma del usuario.
- Devuelve SOLO JSON válido con este esquema:
{
  "reply": "<texto para enviar al usuario>",
  "followup": "<pregunta breve para continuar>",
  "slots": { "city": "...", "zone": "...", "cuisine": "...", "budget": "..." },
  "next_slot": "<city|zone|cuisine|budget|>"
}
- Si tienes al menos CIUDAD/ZONA y un ANTOJO (o el mensaje lo deja claro), da una
  RECOMENDACIÓN INICIAL inmediatamente (2–3 opciones).
- No inventes datos duros (direcciones, horarios, teléfonos). Nombres genéricos están bien
  (p.ej. "Trattoria acogedora en el Centro", "Barra de sushi clásica en Providencia").
- Formato de recomendaciones: viñetas cortas con (tipo de lugar — qué pedir — ambiente).
- Después de recomendar, pide SOLO UN dato que falte (next_slot) con una followup breve.
- Si NO tienes la información mínima (ni ciudad/zona ni antojo), pide solo UNO de esos datos.
- Nunca repitas preguntas ya respondidas en el último turno. Sé conciso.
`;

    const user = `
Usuario: ${username || "Instagram"}
ManyChatID: ${manychat_user_id || ""}
Mensaje: ${message}

Slots actuales:
- city: ${slots.city || "null"}
- zone: ${slots.zone || "null"}
- cuisine: ${slots.cuisine || "null"}
- budget: ${slots.budget || "null"}

Modo: ${canRecommend ? "BEST_EFFORT_RECOMMEND" : "ASK_MINIMUM"}

Recuerda: devuelve SOLO JSON válido.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      temperature: 0.6,
      messages: [
        { role: "system", content: system.trim() },
        { role: "user", content: user.trim() },
      ],
    });

    let content = completion.choices?.[0]?.message?.content?.trim() || "{}";

    // Parse robusto
    let data = {};
    try {
      data = JSON.parse(content);
    } catch {
      const m = content.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          data = JSON.parse(m[0]);
        } catch {}
      }
    }

    // Fallbacks
    const reply =
      clean(data.reply) ||
      (canRecommend
        ? "Aquí van algunas ideas interesantes. ¿Te pido un dato más para afinar?"
        : "¿En qué ciudad estás y qué se te antoja?");
    const followup =
      clean(data.followup) ||
      (canRecommend
        ? (next_slot === "budget"
            ? "¿Cuál es tu presupuesto aproximado?"
            : next_slot === "zone"
            ? "¿Alguna zona de la ciudad que prefieras?"
            : "¿Quieres otra opción o cambiamos de tipo de comida?")
        : next_slot === "city"
        ? "¿En qué ciudad estás?"
        : "¿Qué se te antoja?");
    const outSlots = {
      city: clean(data.slots?.city) || slots.city,
      zone: clean(data.slots?.zone) || slots.zone,
      cuisine: clean(data.slots?.cuisine) || slots.cuisine,
      budget: clean(data.slots?.budget) || slots.budget,
    };
    const outNext = clean(data.next_slot) || next_slot || "";

    return res.json({
      reply,
      followup,
      slots: outSlots,
      next_slot: outNext,
    });
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ reply: "Tuve un problema. ¿Probamos de nuevo?", followup: "" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
