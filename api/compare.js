const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const groqApiKey = process.env.GROQ_API_KEY;

module.exports = async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Método no permitido' });
    }

    try {
        if (!supabaseUrl || !supabaseAnonKey || !groqApiKey) {
            return res.status(500).json({ error: 'Faltan variables de entorno en Vercel.' });
        }

        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Sesión inválida o expirada.' });
        }

        const token = authHeader.split(' ')[1];
        const supabase = createClient(supabaseUrl, supabaseAnonKey, {
            global: { headers: { Authorization: `Bearer ${token}` } }
        });

        const { data: { user }, error: userError } = await supabase.auth.getUser(token);
        if (userError || !user) {
            return res.status(401).json({ error: 'Usuario no autenticado.' });
        }

        let { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', user.id)
            .maybeSingle();

        if (!profile || !profile.is_pro) {
            return res.status(403).json({ error: 'El comparador Versus es una función exclusiva para usuarios PRO.' });
        }

        // Extraemos las dos imágenes, sus tipos y el perfil de salud del usuario
        const { image1Base64, mimeType1, image2Base64, mimeType2, healthProfile } = req.body;
        if (!image1Base64 || !image2Base64) {
            return res.status(400).json({ error: 'Se requieren ambas imágenes para realizar la comparación.' });
        }

        let personalizationPrompt = "";
        if (healthProfile) {
            personalizationPrompt = `
    CONTEXTO MÉDICO Y OBJETIVO DEL USUARIO:
    - Objetivo nutricional: ${healthProfile.goal}
    - Alergias o restricciones: ${healthProfile.notes || "Ninguna especificada"}
    Prioriza cuál de los dos productos se adapta mejor a este perfil de salud específico.`;
        }

        const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${groqApiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'qwen/qwen3.8-27b',
                messages: [
                    {
                        role: 'user',
                        content: [
                            {
                                type: 'text',
                                text: `Compara estos dos productos alimenticios a partir de sus etiquetas o empaques. Evalúa sellos, azúcares añadidos, sodio, calorías e ingredientes. Determina cuál es la opción más saludable. 
Devuelve EXCLUSIVAMENTE un objeto JSON válido (sin texto adicional, sin bloques de código markdown como \`\`\`) con esta estructura exacta:
{
  "winner": "Nombre del producto ganador",
  "reason": "Por qué es la mejor opción de manera clara y directa.",
  "product1": {
    "name": "Nombre Producto 1",
    "score": 65,
    "scoreBg": "bg-amber-500",
    "seals": ["Exceso Azúcares"]
  },
  "product2": {
    "name": "Nombre Producto 2",
    "score": 85,
    "scoreBg": "bg-emerald-500",
    "seals": ["Sin Sellos"]
  },
  "summary": "Resumen comparativo detallado de ambos productos."
}${personalizationPrompt}`
                            },
                            {
                                type: 'image_url',
                                image_url: { url: `data:${mimeType1 || 'image/jpeg'};base64,${image1Base64}` }
                            },
                            {
                                type: 'image_url',
                                image_url: { url: `data:${mimeType2 || 'image/jpeg'};base64,${image2Base64}` }
                            }
                        ]
                    }
                ],
                temperature: 0.2,
                max_tokens: 800
            })
        });

        const groqData = await groqResponse.json();
        if (!groqResponse.ok) {
            return res.status(500).json({ error: groqData.error?.message || 'Error en Groq API.' });
        }

        let rawContent = groqData.choices[0].message.content.trim();
        rawContent = rawContent.replace(/^```json\s*/, '').replace(/^```\s*/, '').replace(/\s*```$/, '');
        
        const comparison = JSON.parse(rawContent);

        // Guardamos el resultado principal en el historial del usuario PRO
        await supabase.from('scan_history').insert({
            user_id: user.id,
            product_name: `Versus: ${comparison.product1.name} vs ${comparison.product2.name}`,
            category: 'Comparación Versus',
            score: comparison.winner === comparison.product1.name ? comparison.product1.score : comparison.product2.score,
            summary: comparison.reason,
            seals: [comparison.winner === comparison.product1.name ? 'Ganador: Prod 1' : 'Ganador: Prod 2'],
            category_class: 'bg-indigo-100 text-indigo-800',
            score_bg: 'bg-indigo-500'
        });

        return res.status(200).json({
            success: true,
            comparison
        });

    } catch (err) {
        console.error('Error crítico en Versus:', err);
        return res.status(500).json({ error: err.message || 'Error interno en el servidor.' });
    }
};
