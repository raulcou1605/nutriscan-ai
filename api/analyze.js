export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { imageBase64, mimeType } = req.body;
    const apiKey = process.env.GEMINI_API_KEY;

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

    // Usando el modelo oficial estable de Google Gemini
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
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

    const data = await response.json();

    if (data.error) {
      return res.status(500).json({ error: data.error.message || "Error en la API de Google" });
    }

    const textResponse = data.candidates[0].content.parts[0].text;
    let cleanJson = textResponse.replace(/```json/g, '').replace(/```/g, '').trim();
    
    const firstBrace = cleanJson.indexOf('{');
    const lastBrace = cleanJson.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) {
      cleanJson = cleanJson.substring(firstBrace, lastBrace + 1);
    }

    const parsedData = JSON.parse(cleanJson);
    return res.status(200).json(parsedData);

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
