export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { imageBase64, mimeType } = req.body;
  const groqKey = process.env.GROQ_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  if (!imageBase64) {
    return res.status(400).json({ error: 'No se ha proporcionado ninguna imagen.' });
  }

  const promptText = `Analiza esta imagen de un producto alimenticio. Identifica el producto real y devuelve únicamente un objeto JSON estricto con esta estructura exacta, sin texto adicional ni bloques markdown:
  {
    "category": "Categoría del producto",
    "categoryClass": "bg-rose-100 text-rose-800",
    "name": "Nombre completo del producto",
    "subtitle": "Descripción breve",
    "score": 50,
    "scoreBg": "bg-amber-500",
    "seals": ["EXCESO SODIO"],
    "harmful": [{"name": "Ingrediente", "damage": "Efecto breve"}],
    "benefits": [{"text": "Beneficio nutricional"}],
    "summary": "Resumen ejecutivo para voz."
  }`;

  // 1. INTENTO PRINCIPAL: GROQ (Velocidad instantánea con Llama 4 Vision)
  if (groqKey) {
    try {
      const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${groqKey}`
        },
        body: JSON.stringify({
          model: "meta-llama/llama-4-scout-17b-16e-instruct",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: promptText },
                {
                  type: "image_url",
                  image_url: {
                    url: `data:${mimeType || "image/jpeg"};base64,${imageBase64}`
                  }
                }
              ]
            }
          ],
          temperature: 0.1,
          response_format: { type: "json_object" }
        })
      });

      const groqData = await groqRes.json();

      if (!groqData.error && groqData.choices?.[0]?.message?.content) {
        const parsedData = JSON.parse(groqData.choices[0].message.content);
        return res.status(200).json(parsedData);
      }
      console.warn("Groq falló o saturado, cambiando a respaldo...", groqData.error);
    } catch (err) {
      console.warn("Error de red en Groq, cambiando a respaldo...", err.message);
    }
  }

  // 2. RESPALDO AUTOMÁTICO (FALLBACK): GOOGLE GEMINI
  if (geminiKey) {
    try {
      const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: promptText },
              { inlineData: { mimeType: mimeType || "image/jpeg", data: imageBase64 } }
            ]
          }]
        })
      });

      const geminiData = await geminiRes.json();

      if (!geminiData.error && geminiData.candidates?.[0]?.content?.parts?.[0]?.text) {
        let cleanJson = geminiData.candidates[0].content.parts[0].text
          .replace(/```json/g, '')
          .replace(/```/g, '')
          .trim();

        const firstBrace = cleanJson.indexOf('{');
        const lastBrace = cleanJson.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1) {
          cleanJson = cleanJson.substring(firstBrace, lastBrace + 1);
        }

        return res.status(200).json(JSON.parse(cleanJson));
      }
    } catch (err) {
      return res.status(500).json({ error: "Todos los motores de IA están saturados en este momento. Intenta en unos segundos." });
    }
  }

  return res.status(500).json({ error: "No se pudo completar el análisis. Verifica tus API Keys en Vercel." });
}
