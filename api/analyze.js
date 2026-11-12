export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { imageBase64, mimeType } = req.body;
    const apiKey = process.env.GROQ_API_KEY;

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

    // Petición al modelo multimodal de Groq (ej. Llama 3.2 Vision)
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "llama-3.2-90b-vision-preview",
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

    const data = await response.json();

    if (data.error) {
      return res.status(500).json({ error: data.error.message || "Error en la API de Groq" });
    }

    const textResponse = data.choices[0].message.content;
    const parsedData = JSON.parse(textResponse);

    return res.status(200).json(parsedData);

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
