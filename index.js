// index.js  — Remy backend con memoria de "slots" y respuesta JSON para ManyChat

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { OpenAI } from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- Utilidades simples de extracción ----------
const norm = (s = "") => (s || "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");

const KNOWN_CITIES = [
  "cdmx","ciudad de mexico","mexico city","guadalajara","zapopan","queretaro","santiago de queretaro",
  "monterrey","san pedro","merida","puebla","tijuana","leon","celaya","ibiza","cordoba","cordoba veracruz",
  "veracruz","cancun","polanco","roma","condesa"
];

const KNOWN_ZONES = [
  "centro","polanco","roma","condesa","del valle","napoles","providencia","chapultepec","oblatos","satelite"
];

const CUISINES = [
  "tacos","tacos al pastor","tacos de carnitas","ramen","sushi","pizza","hamburguesas","mariscos","pozole",
  "cochinita","barbacoa","café","cafe","chilaquiles","cortes","parrilla","alitas","tortas","tlayudas","birria"
];

function extractBudget(text) {
  const t = norm(text);
  // $200, 200 pesos, 200 mxn
  const m = t.match(/(?:\$|\bmxn?\b\s*)?(\d{2,5})(?:\s*(?:mxn|pesos)?)?/i);
  return m ? m[1] : "";
}

function extractCity(text) {
  const t = " " + norm(text) + " ";
  // después de "en " capturar 1-3 palabras
  const m = t.match(/\sen\s([a-záéíóúüñ]+(?:\s+[a-záéíóúüñ]+){0,2})\s/);
  if (m) return m[1].trim();
  for (const c of KNOWN_CITIES) if (t.includes(" " + c + " ")) return c;
  return "";
}

function extractZone(text) {
  const t = norm(text);
  for (const z of KNOWN_ZONES) if (t.includes(z)) return z;
  if (t.includes("centro")) return "centro";
  return "";
}

function extractCuisine(text) {
  const t = norm(text);
  // el más específico primero
  for (const c of CUISINES.sort((a, b) => b.length - a.length)) {
    if (t.includes(norm(c))) return c;
  }
  // frases genéricas
  if (t.includes("antojo") || t.includes("se me antoja")) {
    const m = t.match(/antoja(?:\s+de)?\s+([a-záéíóúüñ\s]{3,25})/i);
    if (m) return m[1].trim();
  }
  return "";
}

function mergeSlots(prev = {}, incoming = {}) {
  // Mantén lo previo si lo nuevo está vacío
  const out = { city: "", zone: "", cuisine: "", budget: "", ...prev };
  for (const k of ["city", "zone", "cuisine", "budget"]) {
    if (incoming[k]) out[k] = String(incoming[k]).trim();
  }
  return out;
}

function detectReset(text) {
  const t = norm(text);
  return /reset|reinicia|empecemos de nuevo|olvida todo|borrar conversacion/.test(t);
}

function nextMissingSlot(slots) {
  if (!slots.city) return "city";
  if (!slots.cuisine) return "cuisine";
  if (!slots.budget) return "budget";
  if (!slots.zone) return "zone"; // zona es opcional, la pedimos al final
  return "none";
}

// ---------- Prompting ----------
function systemPrompt() {
  return `
Eres Remy, un guía amable de restaurantes. Objetivo:
- Mantén CONTEXTO con los slots {city, zone, cuisine, budget}.
- Si faltan datos, pregunta **solo por un slot a la vez** (pregunta breve).
- Nunca pidas un slot que ya está lleno.
- Si ya tienes lo necesario (city + cuisine; budget opcional), da 2–3 sugerencias útiles:
  * nombre o tipo de lugar (sin inventar datos específicos ni direcciones exactas),
  * por qué encaja (zona, ambiente, ticket aproximado),
  * cierra con UNA pregunta de seguimiento clara.
- Evita respuestas largas y repetitivas.
Devuelve SOLO JSON válido con este esquema EXACTO:
{
  "reply": "<texto para el usuario>",
  "slots": { "city": "...", "zone": "...", "cuisine": "...", "budget": "..." },
  "next_slot": "<city|zone|cuisine|budget|none>"
}`;
}

function userPrompt(message, username, slots, pending) {
  return `
Usuario: ${username || ""}

Mensaje: ${message}

Slots conocidos:
- city: ${slots.city || "-"}
- zone: ${slots.zone || "-"}
- cuisine: ${slots.cuisine || "-"}
- budget: ${slots.budget || "-"}

Si "pending_slot" != "none", prioriza cerrar ese slot si el texto lo llena.
pending_slot: ${pending}
`;
}

// ---------- Rutas ----------
app.get("/", (_req, res) => res.send("remy-ai-backend up"));

// ManyChat -> POST /recommendation
app.post("/recommendation", async (req, res) => {
  let {
    message = "",
    username = "",
    manychat_user_id = "",
    slots: incomingSlots = {},
    pending_slot = "none",
  } = req.body || {};

  // 1) Reset si el usuario lo pide
  if (detectReset(message)) {
    const empty = { city: "", zone: "", cuisine: "", budget: "" };
    return res.json({
      reply:
        "Listo, reinicié la conversación. ¿En qué ciudad estás y qué se te antoja?",
      slots: empty,
      next_slot: "city",
    });
  }

  // 2) Merge de slots previos + detectar nuevos desde el mensaje
  let slots = mergeSlots(incomingSlots, {
    // si el usuario acaba de escribir, intenta extraer
    budget: extractBudget(message),
    city: extractCity(message),
    zone: extractZone(message),
    cuisine: extractCuisine(message),
  });

  // 3) Si había un pending_slot, intenta forzarlo desde el mensaje
  if (pending_slot && pending_slot !== "none") {
    if (pending_slot === "budget" && !slots.budget) slots.budget = extractBudget(message);
    if (pending_slot === "city" && !slots.city) slots.city = extractCity(message);
    if (pending_slot === "zone" && !slots.zone) slots.zone = extractZone(message);
    if (pending_slot === "cuisine" && !slots.cuisine) slots.cuisine = extractCuisine(message);
  }

  // 4) Decide qué falta
  let wantNext = nextMissingSlot(slots);

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.6,
      messages: [
        { role: "system", content: systemPrompt() },
        { role: "user", content: userPrompt(message, username, slots, pending_slot || wantNext) },
      ],
    });

    let content = completion.choices?.[0]?.message?.content?.trim() || "";
    // Intento robusto de parseo JSON
    let reply = "";
    let modelSlots = {};
    let next_slot = wantNext;

    const tryParse = (text) => {
      try { return JSON.parse(text); } catch { 
        const m = text.match(/\{[\s\S]*\}$/); 
        if (m) { try { return JSON.parse(m[0]); } catch {} }
        return null;
      }
    };

    const parsed = tryParse(content);
    if (parsed && typeof parsed === "object") {
      reply = String(parsed.reply || "").trim();
      modelSlots = parsed.slots || {};
      next_slot = parsed.next_slot || next_slot;
    }

    // Merge de slots (modelo puede haber normalizado)
    slots = mergeSlots(slots, modelSlots);

    // Fallbacks
    if (!reply) {
      if (wantNext !== "none") {
        const map = { city: "¿En qué ciudad estás?", cuisine: "¿Qué se te antoja?", budget: "¿Cuál es tu presupuesto aproximado?", zone: "¿Alguna zona o colonia preferida?" };
        reply = map[wantNext] || "¿Qué se te antoja y en qué ciudad estás?";
      } else {
        reply = "Puedo sugerirte lugares según tu antojo, zona y presupuesto. ¿Quieres que te recomiende ahora?";
      }
    }

    // Si faltan slots clave, fuerza el next_slot a lo que realmente falte ahora
    const realNext = nextMissingSlot(slots);
    if (realNext !== "none") next_slot = realNext;

    return res.json({ reply, slots, next_slot });
  } catch (err) {
    console.error(err);
    // Respuesta segura en caso de error
    const fallback = nextMissingSlot(slots);
    const map = { city: "¿En qué ciudad estás?", cuisine: "¿Qué se te antoja?", budget: "¿Cuál es tu presupuesto aproximado?" };
    return res.status(200).json({
      reply: map[fallback] || "¿Qué se te antoja y en qué ciudad estás?",
      slots,
      next_slot: fallback,
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor Remy en puerto ${PORT}`));
