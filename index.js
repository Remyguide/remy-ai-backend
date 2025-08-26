import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { OpenAI } from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ---------- helpers ---------- */

function norm(t = "") {
  return String(t).toLowerCase().trim();
}

function stripGreeting(text = "") {
  // quita “Hola ...” al inicio si aparece
  return text.replace(/^\s*hola[!.,\s-:]*/i, "").trim();
}

function extractJson(text = "") {
  // Devuelve el primer bloque JSON válido que encuentre en el contenido
  if (!text) return null;
  // 1) intento directo
  try {
    return JSON.parse(text);
  } catch {}
  // 2) buscar el primer {...} parseable
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {}
  }
  return null;
}

/* ---------- health check ---------- */
app.get("/", (_req, res) => res.send("remy-ai-backend up"));

/* ---------- main endpoint ---------- */
app.post("/recommendation", async (req, res) => {
  const {
    message,
    username = "",
    manychat_user_id = "",
    city = "",
    area = "",
    budget = "",
    preferences = "",
  } = req.body || {};

  if (!message || !String(message).trim()) {
    return res.status(400).json({ error: "Missing 'message' in body" });
  }

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      temperature: 0.3, // menos creatividad, más foco
      messages: [
        {
          role: "system",
          content: `
Eres **Remy**, experto en restaurantes.

Reglas de oro:
- Responde SIEMPRE en el idioma del usuario.
- No repitas literalmente lo que dijo el usuario ni saludes más de una vez por conversación.
- Si no hay ciudad o zona, PREGUNTA primero por ciudad/colonia antes de recomendar.
- No sugieras lugares de otra ciudad/país a menos que el usuario lo pida explícitamente.
- Pide SOLO una aclaración por turno (zona o presupuesto o tipo de cocina).
- Cuando des opciones, ofrece 2–3 alternativas en la zona del usuario, con: barrio/colonia, por qué vale la pena, y rango de precio ($, $$, $$$).
- Si no tienes data fiable de un lugar específico, no inventes datos: sugiere zonas/tipos y pide permiso para afinar.
- Devuelve SOLO JSON válido con este esquema:
{
  "reply": "<mensaje para el usuario (máx. 3–5 frases, claro y directo)>",
  "followup": "<UNA pregunta breve y específica para avanzar>"
}
          `.trim(),
        },
        {
          role: "user",
          content: `
Contexto de ManyChat (si existe):
- Usuario: ${username || ""}
- ManyChatID: ${manychat_user_id || ""}
- Ciudad: ${city || ""}
- Zona/Colonia: ${area || ""}
- Presupuesto: ${budget || ""}
- Preferencias: ${preferences || ""}

Mensaje del usuario: ${message}
          `.trim(),
        },
      ],
    });

    const content =
      completion.choices?.[0]?.message?.content?.trim() || "";

    // Intentar parsear el JSON que devuelve el modelo
    const parsed = extractJson(content) || {};
    let reply = parsed.reply || "";
    let followup = parsed.followup || "";

    // Limpiezas y barandales anti-eco
    reply = stripGreeting(reply);
    if (!reply || norm(reply) === norm(message)) {
      reply =
        "Puedo recomendarte lugares según zona y presupuesto. ¿En qué colonia estás o qué zona te queda mejor?";
    }
    if (!followup) {
      followup = "¿En qué colonia estás (por ejemplo: Polanco, Roma o Condesa)?";
    }

    // Seguridad: respuesta concisa (evita paredes de texto)
    // (opcional) recorta a unas ~700 chars por si acaso
    if (reply.length > 700) reply = reply.slice(0, 700) + "…";

    return res.json({ reply, followup });
  } catch (err) {
    console.error("OpenAI error:", err?.response?.data || err);
    return res.status(500).json({ error: "Error generating recommendation" });
  }
});

/* ---------- server ---------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});


