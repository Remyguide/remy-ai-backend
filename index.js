import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { OpenAI } from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Health check
app.get("/", (_req, res) => res.send("remy-ai-backend up"));

app.post("/recommendation", async (req, res) => {
  const { message, username = "", manychat_user_id = "" } = req.body || {};

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      temperature: 0.7,
      messages: [
        {
          role: "system",
          content: `Eres Remy, experto en restaurantes del mundo.
Responde SIEMPRE en el mismo idioma del usuario.
Devuelve SOLO JSON válido con este esquema:
{
  "reply": "<texto para enviar al usuario>",
  "followup": "<pregunta breve para continuar la conversación>"
}
No añadas texto fuera del JSON.`,
        },
        {
          role: "user",
          content: `Usuario: ${username}
ManyChatID: ${manychat_user_id}
Mensaje: ${message}`,
        },
      ],
    });

    let content = completion.choices?.[0]?.message?.content?.trim() || "";
    let reply = "";
    let followup = "";

    // Intenta parsear JSON directo
    try {
      const parsed = JSON.parse(content);
      reply = parsed.reply;
      followup = parsed.followup;
    } catch {
      // Si vino texto con JSON embebido, lo extraemos
      const match = content.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          const parsed = JSON.parse(match[0]);
          reply = parsed.reply;
          followup = parsed.followup;
        } catch {}
      }
    }

    // Fallbacks por si el modelo no respetó el formato
    if (!reply) {
      reply =
        content ||
        "Puedo sugerirte lugares en CDMX según tu antojo, zona y presupuesto. ¿Qué se te antoja?";
    }
    if (!followup) {
      followup = "¿Quieres otra opción, cambiar de zona o ajustar presupuesto?";
    }

    return res.json({ reply, followup });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Error generating recommendation" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});

