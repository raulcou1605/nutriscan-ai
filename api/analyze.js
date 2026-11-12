export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { imageBase64, mimeType } = req.body;
    const authHeader = req.headers.authorization;
    const groqKey = process.env.GROQ_API_KEY;
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY;

    if (!authHeader) {
      return res.status(401).json({ error: 'Debes iniciar sesión para escanear productos.' });
    }

    if (!imageBase64) {
      return res.status(400).json({ error: 'No se ha proporcionado ninguna imagen.' });
    }

    // 1. Verificar identidad del usuario con Supabase
    const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        'Authorization': authHeader,
        'apikey': supabaseKey
      }
    });

    if (!userRes.ok) {
      return res.status(401).json({ error: 'Sesión inválida o expirada. Inicia sesión nuevamente.' });
    }
    const user = await userRes.json();

    // 2. Consultar perfil, escaneos de hoy y estado PRO en Supabase
    const profileRes = await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${user.id}&select=*`, {
      headers: {
        'Authorization': authHeader,
        'apikey': supabaseKey
      }
    });
    const profiles = await profileRes.json();
    let profile = profiles[0];

    const today = new Date().toISOString().slice(0, 10);
    let scansToday = profile.scans_today || 0;

    // Si es un día nuevo, reiniciar el contador a 0
    if (profile.last_scan_date !== today) {
      scansToday = 0;
    }

    // 3. Validar límite estricto en el servidor (nadie puede saltárselo cambiando navegador)
    if (!profile.is_pro && scansToday >= 3) {
      return res.status(429).json({ 
        error: 'LIMIT_REACHED',
        message: 'Has alcanzado tus 3 escaneos gratuitos de hoy.' 
      });
    }

    // 4. Llamar a Groq para analizar la imagen
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

    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${groqKey}`
      },
      body: JSON.stringify({
        model: "qwen/qwen3.8-27b",
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

    const data = await groqRes.json();

    if (data.error) {
      return res.status(500).json({ error: `Error de Groq: ${data.error.message}` });
    }

    const parsedData = JSON.parse(data.choices[0].message.content);

    // 5. Actualizar contador de escaneos en Supabase
    const newScansCount = scansToday + 1;
    await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${user.id}`, {
      method: 'PATCH',
      headers: {
        'Authorization': authHeader,
        'apikey': supabaseKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        scans_today: newScansCount,
        last_scan_date: today
      })
    });

    return res.status(200).json({
      analysis: parsedData,
      scans_today: newScansCount,
      is_pro: profile.is_pro
    });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
