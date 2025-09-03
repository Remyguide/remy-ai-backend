import express from "express";
import cors from "cors";

// === (Opcional) OpenAI ===
import OpenAI from "openai";

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const USE_OPENAI = !!process.env.OPENAI_API_KEY;
const openai = USE_OPENAI ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// Memoria simple por usuario (cámbialo a Redis en prod)
const sessions = new Map();
const TTL_MS = 1000 * 60 * 30; // 30 min

function getSession(userId) {
  const now = Date.now();
  let s = sessions.get(userId);
  if (!s || now - s.updatedAt > TTL_MS) {
    s = {
      history: [], // [{role:"user"|"assistant", content:string}]
      slots: {
        city: "",
        zone: "",
        cuisine: "",
        budget: ""
      },
      pending_slot: "", // "city" | "zone" | "cuisine" | "budget" | ""
      updatedAt: now
    };
    sessions.set(userId, s);
  }
  s.updatedAt = now;
  return s;
}

// ---------- Utilidades ----------
function safeStr(v) {
  return (typeof v === "string" ? v : (v ?? "")).toString().trim();
}

// Extractores muy simples (mejorar con NER/RAG cuando gustes)
function extractCity(text) {
  const t = text.toLowerCase();
  if (/\bcdmx\b|\bciudad de méxico\b/.test(t)) return "CDMX";
  if (/\bguadalajara\b/.test(t)) return "Guadalajara";
  if (/\bmonterrey\b/.test(t)) return "Monterrey";
  return "";
}

function extractCuisine(text) {
  const t = text.toLowerCase();
  if (/\btamal(es)?\b/.test(t)) return "tamales";
  if (/\btaco(s)?\b/.test(t)) return "tacos";
  if (/\bsushi\b/.test(t)) return "sushi";
  if (/\bpizza\b/.test(t)) return "pizza";
  return "";
}

function extractZone(text) {
  const t = text.toLowerCase();
  if (/\broma\b/.test(t)) return "Roma";
  if (/\bcondesa\b/.test(t)) return "Condesa";
  if (/\bpolanco\b/.test(t)) return "Polanco";
  if (/\bcentro\b/.test(t)) return "Centro";
  return "";
}

function extractBudget(text) {
  const t = text.toLowerCase();
  // $, $$, $$$
  if (/\$\$\$\$?/.test(t)) {
    const match = t.match(/\$+/);
    return match ? match[0] : "$$";
  }
  if (/barato|econ[oó]mico|barata/.test(t)) return "$";
  if (/medio|normal/.test(t)) return "$$";
  if (/caro|lujo|fine/.test(t)) return "$$$";
  return "";
}

// Decide cuál slot falta
function computeNextSlot(slots) {
  if (!safeStr(slots.city)) return "city";
  if (!safeStr(slots.cuisine)) return "cuisine";
  // zona y presupuesto los pedimos después, no bloquean la primera respuesta
  if (!safeStr(slots.zone)) return "zone";
  if (!safeStr(slots.budget)) return "budget";
  return "";
}

// Genera follow-up con base en next_slot
function followupFor(nextSlot, slots) {
  switch (nextSlot) {
    case "city":
      return "¿En qué ciudad estás?";
    case "cuisine":
      return "¿Qué se te antoja? (ej. tacos, tamales, sushi)";
    case "zone":
      return `¿Qué zona te queda mejor en ${slots.city}? (Roma, Condesa, Polanco, Centro…)`;
    case "budget":
      return "¿Tienes un presupuesto aproximado? (usa $, $$ o $$$)";
    default:
      return "";
  }
}

// Respuesta dummy si no usas OpenAI (para pruebas)
function ruleBasedReply(slots) {
  const { city, zone, cuisine } = slots;
  if (!city || !cuisine) {
    const ask = followupFor(computeNextSlot(slots), slots);
    return ask || "Cuéntame ciudad y antojo para empezar.";
  }
  // Mini repertorio de ejemplo
  if (city === "CDMX" && cuisine === "tamales") {
    const area = zone ? ` en ${zone}` : "";
    return `Para **tamales** en CDMX${area}:\n• Tamales Doña Emi (Roma)\n• La Tamalería de la Abuela (Condesa)\n• Tamales Madre (Centro)\n¿Quieres que filtre por zona o presupuesto?`;
  }
  return `Ok, buscaré opciones de **${cuisine}** en **${city}**. ¿Te queda mejor Roma, Condesa o Polanco?`;
}

// ---------- Servidor ----------
const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.status(200).send("ok"));

// Endpoint que configuraste en ManyChat: POST /recommendation
app.post("/recommendation", async (req, res) => {
  try {
    // === Entrada desde ManyChat (según tus capturas) ===
    const {
      message,              // "{{mensaje_usuario}}"
      username,             // "{{contact.username}}"
      manychat_user_id,     // "{{contact.id}}"
      slots = {},           // { city, zone, cuisine, budget }
      pending_slot          // "{{pending_slot}}"
    } = req.body || {};

    const userId = safeStr(manychat_user_id) || safeStr(username) || "anon";
    const text = safeStr(message);

    const sess = getSession(userId);

    // 1) merge de slots que vengan de ManyChat
    sess.slots.city    = safeStr(slots.city)    || sess.slots.city;
    sess.slots.zone    = safeStr(slots.zone)    || sess.slots.zone;
    sess.slots.cuisine = safeStr(slots.cuisine) || sess.slots.cuisine;
    sess.slots.budget  = safeStr(slots.budget)  || sess.slots.budget;

    // 2) intenta extraer desde el texto libre
    const cityFromText    = extractCity(text);
    const cuisineFromText = extractCuisine(text);
    const zoneFromText    = extractZone(text);
    const budgetFromText  = extractBudget(text);

    if (cityFromText && !sess.slots.city)       sess.slots.city = cityFromText;
    if (cuisineFromText && !sess.slots.cuisine) sess.slots.cuisine = cuisineFromText;
    if (zoneFromText && !sess.slots.zone)       sess.slots.zone = zoneFromText;
    if (budgetFromText && !sess.slots.budget)   sess.slots.budget = budgetFromText;

    // 3) guarda el turno del usuario
    sess.history.push({ role: "user", content: text });

    // 4) genera respuesta (OpenAI si hay API key; si no, reglas simples)
    let replyText = "";
    if (USE_OPENAI) {
      const system = [
        "Eres Remy, un concierge gastronómico en español.",
        "Sé breve, concreto y útil.",
        `Slots actuales: city=${sess.slots.city || "?"}, zone=${sess.slots.zone || "?"}, cuisine=${sess.slots.cuisine || "?"}, budget=${sess.slots.budget || "?"}.`,
        "Si faltan city o cuisine, pide UNO a la vez. Si ya están, da 3-5 opciones y ofrece afinar por zona/presupuesto."
      ].join("\n");

      const messages = [
        { role: "system", content: system },
        ...sess.history.slice(-8), // últimas interacciones
      ];

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.5,
        messages
      });

      replyText = completion.choices?.[0]?.message?.content?.trim() || "";
    } else {
      replyText = ruleBasedReply(sess.slots);
    }

    // 5) decide siguiente slot pendiente
    const nextSlot = computeNextSlot(sess.slots);
    const followup = followupFor(nextSlot, sess.slots);

    // 6) guarda respuesta del asistente en historial
    sess.history.push({ role: "assistant", content: replyText });

    // 7) estructura EXACTA para ManyChat (como en tu mapeo)
    const responsePayload = {
      reply: replyText || (followup || "¿Me cuentas tu ciudad y antojo?"),
      followup,
      slots: {
        city:    sess.slots.city,
        zone:    sess.slots.zone,
        cuisine: sess.slots.cuisine,
        budget:  sess.slots.budget
      },
      next_slot: nextSlot
    };

    return res.status(200).json(responsePayload);
  } catch (err) {
    console.error("Recommendation error:", err);
    // Falla suave: ManyChat puede mapear reply aunque falle algo
    return res.status(200).json({
      reply: "Tuve un problema técnico, ¿puedes repetir tu última petición? 🙏",
      followup: "",
      slots: { city: "", zone: "", cuisine: "", budget: "" },
      next_slot: ""
    });
  }
});

app.listen(PORT, () => {
  console.log(`Remy backend listening on :${PORT}`);
});
